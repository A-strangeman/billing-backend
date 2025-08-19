// server.js - Deployment Ready Version for Render
import express from "express";
import session from "express-session";
import path from "path";
import cors from "cors";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import mysql from "mysql2/promise";

/* ─────────────────────────────────────────────
   Basic Setup
────────────────────────────────────────────── */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, ".env") });

const app = express();
const PORT = process.env.PORT || 4000;

/* ─────────────────────────────────────────────
   Database Connection - Simple & Reliable
────────────────────────────────────────────── */
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: Number(process.env.DB_PORT) || 3306,
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0,
  charset: 'utf8mb4'
});

/* ─────────────────────────────────────────────
   Middleware - Simple but Effective
────────────────────────────────────────────── */
app.set("trust proxy", 1);

// CORS - Liberal settings for troubleshooting
app.use(cors({
  origin: true, // Allow all origins during debugging
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || "supersecretkey",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: process.env.NODE_ENV === 'production' ? "none" : "lax",
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 2 // 2 hours
  },
  rolling: true
}));

app.use(express.static(path.join(__dirname, "public")));

/* ─────────────────────────────────────────────
   Helper Functions
────────────────────────────────────────────── */
const requireAuth = (req, res, next) => {
  console.log("Auth check - Session:", req.session?.userId); // Debug logging
  if (req.session?.userId) return next();
  return res.status(401).json({ success: false, message: "Unauthorized" });
};

const toJSONString = (val) => {
  if (val == null) return "[]";
  if (typeof val === "string") return val;
  try { return JSON.stringify(val); } catch { return "[]"; }
};

const parseItems = (val) => {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  if (typeof val === "object") return val;
  try { return JSON.parse(val); } catch { return []; }
};

const toNum = (v) => Number.isFinite(Number(v)) ? Number(v) : 0;

const buildBillDataRow = (row) => {
  return JSON.stringify({
    estimateNo: row.estimate_no ?? "",
    customerName: row.customer_name ?? "",
    customerPhone: row.customer_phone ?? "",
    billDate: row.bill_date ?? null,
    items: parseItems(row.items),
    subTotal: toNum(row.sub_total),
    discount: toNum(row.discount),
    grandTotal: toNum(row.grand_total),
    received: toNum(row.received),
    balance: toNum(row.balance),
    amountWords: row.amount_words ?? ""
  });
};

/* ─────────────────────────────────────────────
   Health Checks & Debug Endpoints
────────────────────────────────────────────── */
app.get("/", (_req, res) => {
  res.json({
    message: "✅ Billing System API is running",
    version: "1.0.0",
    timestamp: new Date().toISOString(),
    endpoints: [
      "POST /api/login",
      "GET /api/me", 
      "GET /api/get-bills",
      "GET /api/bills/:estimateNo",
      "POST /api/save-bill",
      "PATCH /api/update-bill",
      "DELETE /api/delete-bill",
      "GET /api/get-deleted-bills",
      "POST /api/restore-bill",
      "DELETE /api/permanent-delete-bill"
    ]
  });
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.get("/api/health", async (_req, res) => {
  try {
    const conn = await db.getConnection();
    await conn.ping();
    conn.release();
    res.json({ ok: true, db: "connected", timestamp: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/test-db", async (_req, res) => {
  try {
    const conn = await db.getConnection();
    await conn.ping();
    conn.release();
    res.json({ ok: true, message: "Database connected successfully!" });
  } catch (err) {
    console.error("DB test failed:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ─────────────────────────────────────────────
   Authentication
────────────────────────────────────────────── */
app.post("/api/login", async (req, res) => {
  console.log("Login attempt:", req.body); // Debug log
  
  const { email, password } = req.body || {};
  const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || "").trim();

  console.log("Comparing:", {
    received: { email, password },
    expected: { ADMIN_EMAIL, ADMIN_PASSWORD }
  });

  if (
    (email || "").trim().toLowerCase() === ADMIN_EMAIL &&
    (password || "").trim() === ADMIN_PASSWORD
  ) {
    req.session.userId = "admin";
    console.log("Login successful, session:", req.session.userId);
    return res.json({ success: true, userId: "admin" });
  }
  
  console.log("Login failed");
  return res.status(401).json({ success: false, message: "Invalid credentials" });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get("/api/me", (req, res) => {
  console.log("Auth check - session exists:", !!req.session?.userId);
  if (!req.session?.userId) return res.status(401).json({ authenticated: false });
  res.json({ authenticated: true, userId: req.session.userId });
});

/* ─────────────────────────────────────────────
   Bills CRUD - Core Functionality
────────────────────────────────────────────── */

// Create or Update Bill
app.post("/api/save-bill", requireAuth, async (req, res) => {
  console.log("Save bill request:", req.body); // Debug
  
  const b = req.body || {};
  const userId = req.session.userId;

  if (!b.estimateNo || !b.customerName) {
    return res.status(400).json({ 
      success: false, 
      message: "estimateNo and customerName are required" 
    });
  }

  try {
    const [existing] = await db.query(
      "SELECT id FROM bills WHERE estimate_no = ? AND user_id = ?",
      [String(b.estimateNo), userId]
    );

    const billData = [
      b.customerName || "",
      b.customerPhone || "",
      b.billDate || null,
      toJSONString(b.items),
      toNum(b.subTotal),
      toNum(b.discount),
      toNum(b.grandTotal),
      toNum(b.received),
      toNum(b.balance),
      b.amountWords || ""
    ];

    if (existing.length > 0) {
      await db.query(
        `UPDATE bills SET
         customer_name=?, customer_phone=?, bill_date=?, items=?,
         sub_total=?, discount=?, grand_total=?, received=?, balance=?, amount_words=?
         WHERE id=?`,
        [...billData, existing[0].id]
      );
      console.log("Bill updated:", existing[0].id);
      return res.json({ success: true, action: "updated" });
    } else {
      const [result] = await db.query(
        `INSERT INTO bills
         (estimate_no, customer_name, customer_phone, bill_date, items,
          sub_total, discount, grand_total, received, balance, amount_words, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [String(b.estimateNo), ...billData, userId]
      );
      console.log("Bill created:", result.insertId);
      return res.json({ success: true, action: "inserted" });
    }
  } catch (err) {
    console.error("Save bill error:", err);
    return res.status(500).json({ success: false, message: "Database error: " + err.message });
  }
});

// Get All Bills
app.get("/api/get-bills", requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    console.log("Fetching bills for user:", userId);
    
    const [rows] = await db.query(
      "SELECT * FROM bills WHERE user_id = ? ORDER BY updated_at DESC, created_at DESC",
      [userId]
    );

    console.log("Found bills:", rows.length);
    
    const bills = rows.map(r => ({
      ...r,
      billData: buildBillDataRow(r)
    }));
    
    res.json(bills);
  } catch (err) {
    console.error("Error fetching bills:", err);
    res.status(500).json({ error: "Failed to fetch bills: " + err.message });
  }
});

// Get Single Bill
app.get("/api/bills/:estimateNo", requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    const { estimateNo } = req.params;
    
    console.log("Fetching bill:", estimateNo, "for user:", userId);

    const [rows] = await db.query(
      "SELECT * FROM bills WHERE estimate_no = ? AND user_id = ? LIMIT 1",
      [String(estimateNo), userId]
    );

    if (!rows.length) {
      console.log("Bill not found");
      return res.status(404).json({ success: false, message: "Bill not found" });
    }

    const bill = rows[0];
    bill.billData = buildBillDataRow(bill);
    console.log("Bill found and returned");
    res.json(bill);
  } catch (err) {
    console.error("Error fetching bill:", err);
    res.status(500).json({ error: "Failed to fetch bill: " + err.message });
  }
});

// Update Bill
app.patch("/api/update-bill", requireAuth, async (req, res) => {
  console.log("Update bill request:", req.body);
  
  const { estimateNo, updates } = req.body || {};
  if (!estimateNo || !updates) {
    return res.status(400).json({ 
      success: false, 
      message: "Missing estimateNo or updates" 
    });
  }
  
  const userId = req.session.userId;

  try {
    const [rows] = await db.query(
      "SELECT * FROM bills WHERE estimate_no = ? AND user_id = ? LIMIT 1",
      [String(estimateNo), userId]
    );
    
    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Bill not found" });
    }
    
    const row = rows[0];
    const current = {
      estimateNo: row.estimate_no,
      customerName: row.customer_name,
      customerPhone: row.customer_phone,
      billDate: row.bill_date,
      items: parseItems(row.items),
      subTotal: toNum(row.sub_total),
      discount: toNum(row.discount),
      grandTotal: toNum(row.grand_total),
      received: toNum(row.received),
      balance: toNum(row.balance),
      amountWords: row.amount_words || ""
    };

    const merged = { ...current, ...updates };

    await db.query(
      `UPDATE bills SET
       customer_name=?, customer_phone=?, bill_date=?, items=?,
       sub_total=?, discount=?, grand_total=?, received=?, balance=?, amount_words=?
       WHERE id=?`,
      [
        merged.customerName || "",
        merged.customerPhone || "",
        merged.billDate || null,
        toJSONString(merged.items),
        toNum(merged.subTotal),
        toNum(merged.discount),
        toNum(merged.grandTotal),
        toNum(merged.received),
        toNum(merged.balance),
        merged.amountWords || "",
        row.id
      ]
    );

    console.log("Bill updated successfully");
    return res.json({ success: true, message: "Bill updated." });
  } catch (err) {
    console.error("Update bill error:", err);
    return res.status(500).json({ success: false, message: "Database error: " + err.message });
  }
});

/* ─────────────────────────────────────────────
   Delete Bills (Soft Delete)
────────────────────────────────────────────── */
app.delete("/api/delete-bill", requireAuth, async (req, res) => {
  console.log("Delete bill request:", req.body);
  
  const { estimateNo } = req.body || {};
  if (!estimateNo) {
    return res.status(400).json({ success: false, message: "Missing estimateNo" });
  }
  
  const userId = req.session.userId;
  const conn = await db.getConnection();
  
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      "SELECT * FROM bills WHERE estimate_no = ? AND user_id = ? LIMIT 1",
      [String(estimateNo), userId]
    );
    
    if (!rows.length) {
      await conn.rollback();
      return res.status(404).json({ success: false, message: "Bill not found" });
    }
    
    const bill = rows[0];
    console.log("Moving bill to deleted_bills:", bill.id);

    // Insert into deleted_bills
    await conn.query(
      `INSERT INTO deleted_bills
       (original_bill_id, estimate_no, customer_name, customer_phone, bill_date, items,
        sub_total, discount, grand_total, received, balance, amount_words, user_id, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        bill.id,
        bill.estimate_no,
        bill.customer_name,
        bill.customer_phone,
        bill.bill_date,
        toJSONString(bill.items),
        bill.sub_total,
        bill.discount,
        bill.grand_total,
        bill.received,
        bill.balance,
        bill.amount_words,
        userId
      ]
    );

    await conn.query("DELETE FROM bills WHERE id = ?", [bill.id]);

    await conn.commit();
    console.log("Bill successfully moved to deleted_bills");
    return res.json({ success: true, message: "Bill moved to deleted history." });
  } catch (err) {
    await conn.rollback();
    console.error("Soft delete error:", err);
    return res.status(500).json({ success: false, message: "Database error: " + err.message });
  } finally {
    conn.release();
  }
});

/* ─────────────────────────────────────────────
   Deleted Bills Management
────────────────────────────────────────────── */
app.get("/api/get-deleted-bills", requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    console.log("Fetching deleted bills for user:", userId);
    
    const [rows] = await db.query(
      "SELECT * FROM deleted_bills WHERE user_id = ? ORDER BY deleted_at DESC",
      [userId]
    );
    
    console.log("Found deleted bills:", rows.length);
    return res.json(rows);
  } catch (err) {
    console.error("Get deleted bills error:", err);
    return res.status(500).json({ success: false, message: "Database error: " + err.message });
  }
});

app.post("/api/restore-bill", requireAuth, async (req, res) => {
  console.log("Restore bill request:", req.body);
  
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ success: false, message: "Missing id" });
  
  const userId = req.session.userId;
  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      "SELECT * FROM deleted_bills WHERE id = ? AND user_id = ? LIMIT 1",
      [id, userId]
    );
    
    if (!rows.length) {
      await conn.rollback();
      return res.status(404).json({ success: false, message: "Deleted bill not found" });
    }
    
    const d = rows[0];
    console.log("Restoring bill:", d.estimate_no);

    await conn.query(
      `INSERT INTO bills
       (estimate_no, customer_name, customer_phone, bill_date, items,
        sub_total, discount, grand_total, received, balance, amount_words, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        d.estimate_no,
        d.customer_name,
        d.customer_phone,
        d.bill_date,
        toJSONString(d.items),
        d.sub_total,
        d.discount,
        d.grand_total,
        d.received,
        d.balance,
        d.amount_words,
        userId
      ]
    );

    await conn.query("DELETE FROM deleted_bills WHERE id = ?", [id]);

    await conn.commit();
    console.log("Bill restored successfully");
    return res.json({ success: true, message: "Bill restored." });
  } catch (err) {
    await conn.rollback();
    console.error("Restore bill error:", err);
    return res.status(500).json({ success: false, message: "Database error: " + err.message });
  } finally {
    conn.release();
  }
});

app.delete("/api/permanent-delete-bill", requireAuth, async (req, res) => {
  console.log("Permanent delete request:", req.body);
  
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ success: false, message: "Missing id" });
  
  const userId = req.session.userId;

  try {
    const [result] = await db.query(
      "DELETE FROM deleted_bills WHERE id = ? AND user_id = ?",
      [id, userId]
    );
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Record not found" });
    }
    
    console.log("Bill permanently deleted");
    return res.json({ success: true, message: "Permanently deleted." });
  } catch (err) {
    console.error("Permanent delete error:", err);
    return res.status(500).json({ success: false, message: "Database error: " + err.message });
  }
});

/* ─────────────────────────────────────────────
   Database Initialization
────────────────────────────────────────────── */
async function initDb() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS deleted_bills (
        id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        original_bill_id INT NULL,
        estimate_no VARCHAR(50),
        customer_name VARCHAR(255),
        customer_phone VARCHAR(50),
        bill_date DATE NULL,
        items JSON NULL,
        sub_total DECIMAL(10,2) DEFAULT 0.00,
        discount DECIMAL(10,2) DEFAULT 0.00,
        grand_total DECIMAL(10,2) DEFAULT 0.00,
        received DECIMAL(10,2) DEFAULT 0.00,
        balance DECIMAL(10,2) DEFAULT 0.00,
        amount_words TEXT,
        user_id VARCHAR(100),
        deleted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log("✅ Database tables initialized");
  } catch (error) {
    console.error("❌ Database initialization error:", error);
  }
}

/* ─────────────────────────────────────────────
   Error Handling & Startup
────────────────────────────────────────────── */

// Catch all 404s
app.use("*", (req, res) => {
  console.log("404 - Route not found:", req.method, req.originalUrl);
  res.status(404).json({ error: "Route not found", path: req.originalUrl });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error("Global error:", err);
  res.status(500).json({ error: "Internal server error", message: err.message });
});

// Graceful shutdown
const gracefulShutdown = async (signal) => {
  console.log(`${signal} received, shutting down gracefully`);
  try {
    await db.end();
    console.log('Database connections closed');
  } catch (error) {
    console.error('Error closing database:', error);
  }
  process.exit(0);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Start server
app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🌐 CORS: Liberal (allowing all origins for debugging)`);
  
  try {
    const conn = await db.getConnection();
    conn.release();
    console.log("✅ Database connection established");
    await initDb();
  } catch (e) {
    console.error("⚠️ Database connection failed:", e.message);
  }
});