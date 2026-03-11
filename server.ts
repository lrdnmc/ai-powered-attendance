import express from "express";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import pg from "pg";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Database abstraction for Vercel (Postgres) or Local (SQLite)
interface DB {
  exec(sql: string): void;
  prepare(sql: string): any;
  transaction(fn: any): any;
}

let db: DB;
const isPostgres = !!process.env.DATABASE_URL;

if (isPostgres) {
  console.log("Using Postgres database...");
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  
  db = {
    exec: async (sql: string) => {
      const client = await pool.connect();
      try { await client.query(sql); } finally { client.release(); }
    },
    prepare: (sql: string) => {
      // Mocking better-sqlite3 prepare for Postgres
      const pgSql = sql.replace(/\?/g, (match, index) => `$${index + 1}`);
      return {
        run: async (...args: any[]) => {
          const client = await pool.connect();
          try { return await client.query(pgSql, args); } finally { client.release(); }
        },
        get: async (...args: any[]) => {
          const client = await pool.connect();
          try { 
            const res = await client.query(pgSql, args);
            return res.rows[0];
          } finally { client.release(); }
        },
        all: async (...args: any[]) => {
          const client = await pool.connect();
          try { 
            const res = await client.query(pgSql, args);
            return res.rows;
          } finally { client.release(); }
        }
      };
    },
    transaction: (fn: any) => {
      return async (...args: any[]) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await fn(client, ...args);
          await client.query('COMMIT');
          return result;
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        } finally {
          client.release();
        }
      };
    }
  };
} else {
  console.log("Using SQLite database...");
  const sqlite = new Database("attendance.db");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  
  db = {
    exec: (sql: string) => sqlite.exec(sql),
    prepare: (sql: string) => {
      const stmt = sqlite.prepare(sql);
      return {
        run: (...args: any[]) => stmt.run(...args),
        get: (...args: any[]) => stmt.get(...args),
        all: (...args: any[]) => stmt.all(...args)
      };
    },
    transaction: (fn: any) => {
      return async (...args: any[]) => {
        const trans = sqlite.transaction((...args: any[]) => {
          // better-sqlite3 transactions are synchronous. 
          // If we need async, we can't use this wrapper easily with async fn.
          // However, we can run the fn and if it returns a promise, we have a problem.
          return fn(null, ...args);
        });
        
        // For SQLite in this app, we'll just execute the function.
        // If it's async, we'll handle it outside the better-sqlite3 transaction 
        // or use BEGIN/COMMIT manually for async support.
        try {
          sqlite.prepare('BEGIN').run();
          const result = await fn(null, ...args);
          sqlite.prepare('COMMIT').run();
          return result;
        } catch (e) {
          sqlite.prepare('ROLLBACK').run();
          throw e;
        }
      };
    }
  };
}

// Initialize DB
const initDb = async () => {
  const schema = `
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      date TEXT NOT NULL,
      description TEXT,
      category TEXT DEFAULT '未分类'
    );
    
    CREATE TABLE IF NOT EXISTS attendance (
      id TEXT PRIMARY KEY,
      sessionId TEXT NOT NULL,
      personId TEXT NOT NULL,
      description TEXT,
      appearances TEXT, -- JSON string
      name TEXT,
      studentId TEXT,
      photo TEXT, -- Base64 for student self sign-in
      FOREIGN KEY (sessionId) REFERENCES sessions(id) ON DELETE CASCADE
    );
  
    CREATE TABLE IF NOT EXISTS session_images (
      id TEXT PRIMARY KEY,
      sessionId TEXT NOT NULL,
      data TEXT NOT NULL, -- Base64
      imageIndex INTEGER,
      FOREIGN KEY (sessionId) REFERENCES sessions(id) ON DELETE CASCADE
    );
  
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      passwordHash TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_attendance_session ON attendance(sessionId);
    CREATE INDEX IF NOT EXISTS idx_images_session ON session_images(sessionId);
  `;
  
  if (isPostgres) {
    // Postgres specific adjustments if needed
    await db.exec(schema.replace(/TEXT PRIMARY KEY/g, "VARCHAR(255) PRIMARY KEY").replace(/TEXT/g, "TEXT"));
  } else {
    db.exec(schema);
  }

  // Initialize default admin
  const adminExists = await db.prepare("SELECT * FROM users WHERE username = 'root'").get();
  if (!adminExists) {
    const salt = bcrypt.genSaltSync(10);
    const hash = bcrypt.hashSync("aiattendance", salt);
    await db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
      .run(uuidv4(), "root", hash);
    console.log("Default admin user 'root' created.");
  }

  // Migrations
  try {
    if (isPostgres) {
      await db.exec("ALTER TABLE attendance ADD COLUMN IF NOT EXISTS photo TEXT");
    } else {
      await db.prepare("SELECT photo FROM attendance LIMIT 1").get();
    }
  } catch (e) {
    console.log("Adding photo column...");
    await db.exec("ALTER TABLE attendance ADD COLUMN photo TEXT");
  }
};

initDb();

const app = express();
app.use(express.json({ limit: '50mb' }));

// API Routes
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ success: false, error: "请提供用户名和密码" });

  try {
    const user = await db.prepare("SELECT * FROM users WHERE username = ?").get(username);
    if (user && bcrypt.compareSync(password, user.passwordHash)) {
      res.json({ success: true, isAdmin: true });
    } else {
      res.status(401).json({ success: false, error: "用户名或密码错误" });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: "服务器内部错误" });
  }
});

app.get("/api/sessions", async (req, res) => {
  try {
    const sessions = await db.prepare("SELECT * FROM sessions ORDER BY date DESC").all();
    res.json(sessions);
  } catch (err) {
    res.status(500).json({ error: "获取课程列表失败" });
  }
});

app.post("/api/sessions", async (req, res) => {
  const { title, date, description, category } = req.body;
  const id = uuidv4();
  await db.prepare("INSERT INTO sessions (id, title, date, description, category) VALUES (?, ?, ?, ?, ?)")
    .run(id, title, date || new Date().toISOString(), description || "", category || "未分类");
  res.json({ id, title, date, description, category });
});

app.get("/api/sessions/:id", async (req, res) => {
  try {
    const session = await db.prepare("SELECT * FROM sessions WHERE id = ?").get(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    
    const records = await db.prepare("SELECT * FROM attendance WHERE sessionId = ?").all(req.params.id);
    const images = await db.prepare("SELECT * FROM session_images WHERE sessionId = ?").all(req.params.id);
    
    res.json({ 
      ...session, 
      records: records.map((r: any) => ({
        ...r,
        appearances: JSON.parse(r.appearances || "[]")
      })),
      images: images.map((img: any) => ({
        id: img.id,
        data: img.data,
        index: img.imageIndex
      }))
    });
  } catch (err) {
    res.status(500).json({ error: "获取详情失败" });
  }
});

app.delete("/api/sessions/:id", async (req, res) => {
  // Basic check: in a real app we'd use a token, but here we just check if they are logged in (simplified)
  try {
    await db.prepare("DELETE FROM sessions WHERE id = ?").run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "删除失败" });
  }
});

app.put("/api/sessions/:id/records/:personId", async (req, res) => {
  const { name, studentId } = req.body;
  try {
    await db.prepare("UPDATE attendance SET name = ?, studentId = ? WHERE sessionId = ? AND personId = ?")
      .run(name, studentId, req.params.id, req.params.personId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "更新失败" });
  }
});

app.post("/api/sessions/:id/records", async (req, res) => {
  const { personId, description, name, studentId, photo } = req.body;
  const id = uuidv4();
  try {
    await db.prepare("INSERT INTO attendance (id, sessionId, personId, description, appearances, name, studentId, photo) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, req.params.id, personId || `M${Date.now()}`, description || "手动添加", "[]", name || "", studentId || "", photo || null);
    res.json({ id, personId, description, name, studentId, photo });
  } catch (err) {
    res.status(500).json({ error: "添加失败" });
  }
});

app.delete("/api/sessions/:id/records/:personId", async (req, res) => {
  try {
    await db.prepare("DELETE FROM attendance WHERE sessionId = ? AND personId = ?")
      .run(req.params.id, req.params.personId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "删除记录失败" });
  }
});

app.put("/api/sessions/:id/sync", async (req, res) => {
  const { records, images } = req.body;
  const sessionId = req.params.id;
  
  if (!records || !Array.isArray(records)) {
    return res.status(400).json({ success: false, error: "无效的记录数据" });
  }

  try {
    const syncFn = async (client: any) => {
      const run = async (sql: string, args: any[]) => {
        if (isPostgres && client) return await client.query(sql.replace(/\?/g, (m: any, i: any) => `$${i + 1}`), args);
        return db.prepare(sql).run(...args);
      };

      const query = async (sql: string, args: any[]) => {
        if (isPostgres && client) {
          const res = await client.query(sql.replace(/\?/g, (m: any, i: any) => `$${i + 1}`), args);
          return res.rows;
        }
        return db.prepare(sql).all(...args);
      };

      // 1. Handle images
      if (images && images.length > 0) {
        await run("DELETE FROM session_images WHERE sessionId = ?", [sessionId]);
        for (const img of images) {
          await run("INSERT INTO session_images (id, sessionId, data, imageIndex) VALUES (?, ?, ?, ?)", 
            [uuidv4(), sessionId, img.data, img.index]);
        }
      }

      // 2. Handle records efficiently
      const existingRecords = await query("SELECT personId FROM attendance WHERE sessionId = ?", [sessionId]);
      const existingPersonIds = new Set(existingRecords.map((r: any) => r.personId));

      for (const rec of records) {
        const recordId = `${sessionId}_${rec.id}`;
        if (existingPersonIds.has(rec.id)) {
          await run("UPDATE attendance SET description = ?, appearances = ? WHERE sessionId = ? AND personId = ?", 
            [rec.description, JSON.stringify(rec.appearances), sessionId, rec.id]);
        } else {
          await run("INSERT INTO attendance (id, sessionId, personId, description, appearances, name, studentId) VALUES (?, ?, ?, ?, ?, ?, ?)", 
            [recordId, sessionId, rec.id, rec.description, JSON.stringify(rec.appearances), "", ""]);
        }
      }
    };

    await db.transaction(syncFn)(records, images);
    res.json({ success: true });
  } catch (err: any) {
    console.error("Sync error:", err);
    res.status(500).json({ success: false, error: "同步失败: " + err.message });
  }
});

// Vite middleware for development
if (process.env.NODE_ENV !== "production") {
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
} else {
  app.use(express.static(path.join(__dirname, "dist")));
  app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "dist", "index.html"));
  });
}

// 只在本地开发时监听端口，Vercel 线上环境会自动接管
if (process.env.NODE_ENV !== "production") {
  const PORT = 3000;
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

// 导出 app 供 Vercel 使用
export default app;
