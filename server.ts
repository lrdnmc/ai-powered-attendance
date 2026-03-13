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

// 💡 全局防崩溃护盾：无论哪里发生报错，绝对不让服务器闪退引发 503！
process.on('uncaughtException', (err) => console.error('💥 未捕获的全局异常:', err));
process.on('unhandledRejection', (reason) => console.error('💥 未处理的 Promise 拒绝:', reason));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
    // 👇 1. 修改：延长到 30 秒 (30000)，给足 Neon 深睡唤醒时间
    connectionTimeoutMillis: 30000, 
    // 👇 2. 新增：开启 TCP 底层心跳，防止在长达 30 秒的等待中被 Cloud Run 掐断网线
    keepAlive: true,                
    allowExitOnIdle: true
  });

  // 👇 补回这个避雷针，防止后台断连引发 503 崩溃
  pool.on('error', (err, client) => {
    console.error('⚠️ 数据库后台僵尸连接已被清理 (安全拦截):', err.message);
  });

  
  
  db = {
    exec: async (sql: string) => {
      const client = await pool.connect();
      try { await client.query(sql); } finally { client.release(); }
    },
    prepare: (sql: string) => {
      let paramIndex = 1;
      const pgSql = sql.replace(/\?/g, () => `$${paramIndex++}`);

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
      appearances TEXT,
      name TEXT,
      studentId TEXT,
      photo TEXT,
      FOREIGN KEY (sessionId) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS session_images (
      id TEXT PRIMARY KEY,
      sessionId TEXT NOT NULL,
      data TEXT NOT NULL,
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

  const adminExists = await db.prepare("SELECT * FROM users WHERE username = 'root'").get();
  if (!adminExists) {
    const salt = bcrypt.genSaltSync(10);
    const hash = bcrypt.hashSync("aiattendance", salt);
    await db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
      .run(uuidv4(), "root", hash);
    console.log("Default admin user 'root' created.");
  }

  try {
    if (isPostgres) {
      await db.exec("ALTER TABLE attendance ADD COLUMN IF NOT EXISTS photo TEXT");
    } else {
      await db.prepare("SELECT photo FROM attendance LIMIT 1").get();
    }
  } catch (e) {
    try { await db.exec("ALTER TABLE attendance ADD COLUMN photo TEXT"); } catch(err){}
  }
};

const app = express();
app.use(express.json({ limit: '50mb' }));

app.get("/api/health", (req, res) => res.json({ status: "ok" }));

app.post("/api/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await db.prepare("SELECT * FROM users WHERE username = ?").get(username);
    
    // 👇 关键修复：把 user.passwordHash 改成 (user.passwordhash || user.passwordHash)
    if (user && bcrypt.compareSync(password, user.passwordhash || user.passwordHash)) {
      res.json({ success: true, isAdmin: true });
    } else {
      res.status(401).json({ success: false, error: "用户名或密码错误" });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: "服务器错误" });
  }
});

app.get("/api/sessions", async (req, res) => {
  try {
    const sessions = await db.prepare("SELECT * FROM sessions ORDER BY date DESC").all();
    res.json(sessions);
  } catch (err) { 
    res.status(500).json({ error: "获取失败" }); 
  }
});

app.post("/api/sessions", async (req, res) => {
  try {
    const { title, date, description, category } = req.body;
    const id = uuidv4();
    await db.prepare("INSERT INTO sessions (id, title, date, description, category) VALUES (?, ?, ?, ?, ?)")
      .run(id, title, date || new Date().toISOString(), description || "", category || "未分类");
    res.json({ id, title, date, description, category });
  } catch (err: any) {
    console.error("新建课程失败:", err);
    res.status(500).json({ error: "新建课程失败: " + err.message });
  }
});

app.get("/api/sessions/:id", async (req, res) => {
  try {
    const session = await db.prepare("SELECT * FROM sessions WHERE id = ?").get(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    const records = await db.prepare("SELECT * FROM attendance WHERE sessionId = ?").all(req.params.id);
    const images = await db.prepare("SELECT * FROM session_images WHERE sessionId = ?").all(req.params.id);
    
    // 👇 补丁 3：将所有 Postgres 小写字段映射回驼峰命名，确保前端正确渲染 AI 列表
    res.json({ 
      ...session, 
      records: records.map((r: any) => ({ 
        ...r, 
        personId: r.personid || r.personId,
        sessionId: r.sessionid || r.sessionId,
        studentId: r.studentid || r.studentId,
        appearances: JSON.parse(r.appearances || "[]") 
      })),
      images: images.map((img: any) => ({ 
        id: img.id, 
        data: img.data, 
        index: img.imageindex ?? img.imageIndex 
      }))
    });
  } catch (err) { 
    res.status(500).json({ error: "获取详情失败" }); 
  }
});

app.delete("/api/sessions/:id", async (req, res) => {
  try {
    await db.prepare("DELETE FROM session_images WHERE sessionId = ?").run(req.params.id);
    await db.prepare("DELETE FROM attendance WHERE sessionId = ?").run(req.params.id);
    await db.prepare("DELETE FROM sessions WHERE id = ?").run(req.params.id);
    res.json({ success: true });
  } catch (err) { 
    res.status(500).json({ error: "删除失败" }); 
  }
});

app.put("/api/sessions/:id", async (req, res) => {
  try {
    const { title, date, description, category } = req.body;
    await db.prepare("UPDATE sessions SET title = ?, date = ?, description = ?, category = ? WHERE id = ?")
      .run(title, date || new Date().toISOString(), description || "", category || "未分类", req.params.id);
    res.json({ success: true });
  } catch (err) { 
    res.status(500).json({ error: "更新失败" }); 
  }
});

app.put("/api/sessions/:id/records/:personId", async (req, res) => {
  try {
    const { name, studentId } = req.body;
    await db.prepare("UPDATE attendance SET name = ?, studentId = ? WHERE sessionId = ? AND personId = ?")
      .run(name, studentId, req.params.id, req.params.personId);
    res.json({ success: true });
  } catch (err) { 
    res.status(500).json({ error: "更新失败" }); 
  }
});

app.post("/api/sessions/:id/records", async (req, res) => {
  try {
    const { personId, description, name, studentId, photo } = req.body;
    const id = uuidv4();
    await db.prepare("INSERT INTO attendance (id, sessionId, personId, description, appearances, name, studentId, photo) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, req.params.id, personId || `M${Date.now()}`, description || "手动添加", "[]", name || "", studentId || "", photo || null);
    res.json({ id, personId, description, name, studentId, photo });
  } catch (err: any) { 
    res.status(500).json({ error: err.message }); 
  }
});

app.delete("/api/sessions/:id/records/:personId", async (req, res) => {
  try {
    await db.prepare("DELETE FROM attendance WHERE sessionId = ? AND personId = ?").run(req.params.id, req.params.personId);
    res.json({ success: true });
  } catch (err) { 
    res.status(500).json({ error: "删除失败" }); 
  }
});

app.post("/api/sessions/:id/records/batch-delete", async (req, res) => {
  try {
    const { personIds } = req.body;
    if (!personIds || !Array.isArray(personIds) || personIds.length === 0) return res.status(400).json({ success: false, error: "缺少ID" });
    const placeholders = personIds.map(() => '?').join(',');
    await db.prepare(`DELETE FROM attendance WHERE sessionId = ? AND personId IN (${placeholders})`).run(req.params.id, ...personIds);
    res.json({ success: true, deletedCount: personIds.length });
  } catch (err: any) { 
    res.status(500).json({ success: false, error: err.message }); 
  }
});

app.put("/api/sessions/:id/sync", async (req, res) => {
  try {
    const { records, images } = req.body;
    const sessionId = req.params.id;
    const syncFn = async (client: any) => {

      // 👇 补丁 1：修复问号替换 Bug，保证 SQL 语句合法
      const run = async (sql: string, args: any[]) => {
        if (isPostgres && client) {
          let paramIndex = 1;
          return await client.query(sql.replace(/\?/g, () => `$${paramIndex++}`), args);
        }
        return db.prepare(sql).run(...args);
      };
      const query = async (sql: string, args: any[]) => {
        if (isPostgres && client) {
          let paramIndex = 1;
          const res = await client.query(sql.replace(/\?/g, () => `$${paramIndex++}`), args);
          return res.rows;
        }
        return db.prepare(sql).all(...args);
      };

      if (images && images.length > 0) {
        await run("DELETE FROM session_images WHERE sessionId = ?", [sessionId]);
        for (const img of images) {
          await run("INSERT INTO session_images (id, sessionId, data, imageIndex) VALUES (?, ?, ?, ?)", [uuidv4(), sessionId, img.data || "", img.index || 0]);
        }
      }
      
      const existingRecords = await query("SELECT personId FROM attendance WHERE sessionId = ?", [sessionId]);
      
      // 👇 补丁 2：兼容 Postgres 小写的 personid，防止主键冲突导致保存失败
      const existingPersonIds = new Set(existingRecords.map((r: any) => r.personid || r.personId));

      for (const rec of records) {
        const safeId = rec.id || `P_AUTO_${Math.random().toString(36).slice(2, 6)}`;
        const safeDesc = rec.description || "";
        const safeApp = JSON.stringify(rec.appearances || []);
        if (existingPersonIds.has(safeId)) {
          await run("UPDATE attendance SET description = ?, appearances = ? WHERE sessionId = ? AND personId = ?", [safeDesc, safeApp, sessionId, safeId]);
        } else {
          await run("INSERT INTO attendance (id, sessionId, personId, description, appearances, name, studentId) VALUES (?, ?, ?, ?, ?, ?, ?)", [`${sessionId}_${safeId}`, sessionId, safeId, safeDesc, safeApp, "", ""]);
          existingPersonIds.add(safeId);
        }
      }
    };
    await db.transaction(syncFn)(records, images);
    res.json({ success: true });
  } catch (err: any) { 
    res.status(500).json({ success: false, error: err.message }); 
  }
});

app.post("/api/analyze-attendance", async (req, res) => {
  try {
    const { images } = req.body; 
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ success: false, error: "未配置 API Key" });

    const ai = new GoogleGenAI({ apiKey });
    const contents: any[] = [];
    
    images.forEach((img: any, index: number) => {
      const base64Data = img.data.includes(',') ? img.data.split(',')[1] : img.data;
      contents.push({ text: `[IMG ${index + 1}]` });
      contents.push({ inlineData: { data: base64Data, mimeType: "image/jpeg" } });
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
      model: "gemini-3-flash-preview",
      contents: [{ parts: contents }],
      config: {
        temperature: 0.1,
        maxOutputTokens: 16384,
        responseMimeType: "application/json",
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
                  properties: { i: { type: Type.INTEGER }, b: { type: Type.ARRAY, items: { type: Type.NUMBER } } },
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
    if (!text) throw new Error("AI 返回为空");
    
    let jsonText = text;
    const startIndex = text.indexOf('[');
    const endIndex = text.lastIndexOf(']');
    if (startIndex !== -1 && endIndex !== -1) {
      jsonText = text.substring(startIndex, endIndex + 1);
    }
    
    let compactData;
    try {
      compactData = JSON.parse(jsonText);
    } catch (e) {
      throw new Error("AI 输出格式异常，请重试");
    }
    
    const mappedData = compactData.map((item: any, idx: number) => ({
      id: item.id || `P${idx}`,
      description: item.d || "未知描述",
      appearances: (item.a || []).map((app: any) => ({
        imageIndex: app.i || 1,
        imageName: images[(app.i || 1) - 1]?.name || `Image`,
        box_2d: app.b || [0, 0, 0, 0]
      }))
    }));

    res.json({ success: true, data: mappedData });
  } catch (error: any) {
    console.error("AI Error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

const isCloudRunEnv = !!process.env.K_SERVICE || process.env.NODE_ENV === "production";

if (!isCloudRunEnv) {
  (async () => {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  })();
} else {
  app.use(express.static(path.join(__dirname, "dist")));
  app.get("*", (req, res) => res.sendFile(path.join(__dirname, "dist", "index.html")));
}

// 端口监听配置必须在整个文件的最底部
const PORT = process.env.PORT || 8080;

app.listen(PORT as number, "0.0.0.0", () => {
  console.log(`✅ Web Server is successfully listening on port ${PORT}`);
  
  // 服务器启动后，再开始安全地去初始化数据库
  initDb()
    .then(() => console.log("✅ 数据库连接与表结构初始化全部完成"))
    .catch((err) => console.error("❌ 数据库初始化失败:", err));
});

export default app;