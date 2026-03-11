import express from "express";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import pg from "pg";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import { GoogleGenAI, Type } from "@google/genai";

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
  // 💡 修改1：判断如果是 Cloud Run 或生产环境，使用内存挂载目录 /tmp 防止只读报错
  const isCloudRun = !!process.env.K_SERVICE || process.env.NODE_ENV === "production";
  const dbPath = isCloudRun ? "/tmp/attendance.db" : "attendance.db";
  
  const sqlite = new Database(dbPath);
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
          return fn(null, ...args);
        });
        
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
  } catch (err: any) {
    // 💡 修改3：抛出真实的错误给前端，方便调试排错
    console.error("【数据库写入详细错误】:", err);
    res.status(500).json({ error: `数据库添加失败: ${err.message || String(err)}` });
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

// 💡 新增：批量删除接口
app.post("/api/sessions/:id/records/batch-delete", async (req, res) => {
  const { personIds } = req.body;
  
  if (!personIds || !Array.isArray(personIds) || personIds.length === 0) {
    return res.status(400).json({ success: false, error: "请提供要删除的记录ID数组" });
  }

  try {
    const placeholders = personIds.map(() => '?').join(',');
    await db.prepare(`DELETE FROM attendance WHERE sessionId = ? AND personId IN (${placeholders})`)
      .run(req.params.id, ...personIds);
      
    res.json({ success: true, deletedCount: personIds.length });
  } catch (err: any) {
    console.error("Batch delete error:", err);
    res.status(500).json({ success: false, error: `批量删除失败: ${err.message}` });
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

      // 1. Handle images (防 null 处理)
      if (images && images.length > 0) {
        await run("DELETE FROM session_images WHERE sessionId = ?", [sessionId]);
        for (const img of images) {
          await run("INSERT INTO session_images (id, sessionId, data, imageIndex) VALUES (?, ?, ?, ?)", 
            [uuidv4(), sessionId, img.data || "", img.index || 0]);
        }
      }

      // 2. Handle records efficiently
      const existingRecords = await query("SELECT personId FROM attendance WHERE sessionId = ?", [sessionId]);
      const existingPersonIds = new Set(existingRecords.map((r: any) => r.personId));

      for (const rec of records) {
        const recordId = `${sessionId}_${rec.id}`;
        
        // 💡 核心修复：强制消除 undefined，防止 Postgres 驱动崩溃
        const safeDescription = rec.description || "";
        const safeAppearances = JSON.stringify(rec.appearances || []);

        if (existingPersonIds.has(rec.id)) {
          await run("UPDATE attendance SET description = ?, appearances = ? WHERE sessionId = ? AND personId = ?", 
            [safeDescription, safeAppearances, sessionId, rec.id]);
        } else {
          await run("INSERT INTO attendance (id, sessionId, personId, description, appearances, name, studentId) VALUES (?, ?, ?, ?, ?, ?, ?)", 
            [recordId, sessionId, rec.id, safeDescription, safeAppearances, "", ""]);
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

app.post("/api/analyze-attendance", async (req, res) => {
  try {
    const { images } = req.body; 
    
    const apiKey = process.env.GEMINI_API_KEY;
    
    if (!apiKey || apiKey === "undefined" || apiKey === "null" || apiKey.trim() === "") {
      return res.status(500).json({ 
        success: false, 
        error: "服务器端未配置 API Key 环境变量，请管理员在 Google Cloud Run 的“变量和密钥”中设置 GEMINI_API_KEY。" 
      });
    }

    const ai = new GoogleGenAI({ apiKey });
    const contents: any[] = [];
    
    images.forEach((img: any, index: number) => {
      const base64Data = img.data.includes(',') ? img.data.split(',')[1] : img.data;
      contents.push({ text: `[IMG ${index + 1}] ${img.name}` });
      contents.push({
        inlineData: { data: base64Data, mimeType: "image/jpeg" },
      });
    });

    const prompt = `
    你是一个顶级课堂考勤助手。这是一个大型课程（约 41 人）。
    请深度分析照片，识别出**尽可能多**的不重复到课人员。
    
    关键准则：
    1. **真实识别**：根据照片实际情况识别，不需要强行凑满 41 人。
    2. **必须有头**：仅识别头部清晰可见的人员，**严禁**识别只有身体、没有头部的目标。**严禁**将衣服、窗帘、椅子或其他非生物物体误认为人员。
    3. **全场扫描**：仔细寻找后排、角落、侧脸或被部分遮挡的真实人员。
    4. **跨图去重与关联**：
       - 通过面部、发型、衣着和座位位置确保同一个人只出现一次。
       - **跨图一致性**：如果一个人出现在多张图中，必须深度比对细节，确保确实是同一个人。如果无法 100% 确定是同一人，请作为不同人员处理。
    5. **详细描述**：对人员的特征进行详细描述（15-30字），包括性别、发型、眼镜、衣服颜色及款式、配饰、座位位置特征等。用中文进行描述。
    6. **严格使用极简 JSON 结构**：
       [{"id":"P1","d":"描述","a":[{"i":1,"b":[y,x,y,x]}]}]
       i 是图片索引(1-based)，b 是 [ymin, xmin, ymax, xmax]。
    
    请直接返回 JSON 数组，不要任何开头或结尾文字。
    `;

    contents.push({ text: prompt });

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash", 
      contents: [{ parts: contents }],
      config: {
        responseMimeType: "application/json",
        maxOutputTokens: 16384,
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              id: { type: Type.STRING },
              d: { type: Type.STRING },
              a: {
                type: Type.ARRAY, 
                items: { 
                  type: Type.OBJECT,
                  properties: {
                    i: { type: Type.INTEGER },
                    b: { type: Type.ARRAY, items: { type: Type.NUMBER } }
                  },
                  required: ["i", "b"]
                }
              },
            },
            required: ["id", "d", "a"],
          },
        },
      },
    });

    const text = response.text;
    if (!text) throw new Error("AI 未返回有效内容");
    
    const jsonText = text.trim().replace(/^```json\n?/, "").replace(/\n?```$/, "").replace(/^```\n?/, "").replace(/\n?```$/, "");
    const compactData = JSON.parse(jsonText);
    
    const mappedData = compactData.map((item: any) => ({
      id: item.id,
      description: item.d,
      appearances: item.a.map((app: any) => ({
        imageIndex: app.i,
        imageName: images[app.i - 1]?.name || `Image ${app.i}`,
        box_2d: app.b
      }))
    }));

    res.json({ success: true, data: mappedData });

  } catch (error: any) {
    console.error("Backend AI Error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

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

const PORT = process.env.PORT || 3000;

// 💡 修改2：强制等待数据库初始化与建表完全结束，再开始接收前端请求
initDb()
  .then(() => {
    app.listen(PORT as number, "0.0.0.0", () => {
      console.log(`✅ Server successfully running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("❌ 数据库初始化彻底失败:", err);
  });

export default app;