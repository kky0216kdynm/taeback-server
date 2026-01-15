require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");

const multer = require("multer");
const xlsx = require("xlsx");
const upload = multer({ storage: multer.memoryStorage() });

const app = express();
app.use(cors());
app.use(express.json());

// ----------------------------------------------------
// DB
// ----------------------------------------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

// ----------------------------------------------------
// Utils
// ----------------------------------------------------
function hashPassword(password) {
  return crypto.createHash("sha256").update(password).digest("hex");
}

function parseAmount(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return v;
  const n = Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : 0;
}

function extractOrderIdFromMemo(memo) {
  // 예: "order:123" 또는 "ORD-123" 같은 패턴을 쓰고 싶으면 여기 수정
  if (!memo) return null;
  const s = String(memo);
  const m = s.match(/order[:\s-]*(\d+)/i);
  if (m) return Number(m[1]);
  return null;
}

function extractTopupKeyFromMemo(memo) {
  // 예: "topup:USERID:TOPUPID" 형태를 쓰는 경우
  if (!memo) return null;
  const s = String(memo);
  const m = s.match(/topup[:\s-]*(\d+)[:\s-]*(\d+)/i);
  if (m) return { userId: Number(m[1]), topupId: Number(m[2]) };
  return null;
}

function readExcel(buffer) {
  const wb = xlsx.read(buffer, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return xlsx.utils.sheet_to_json(ws, { defval: "" });
}

// ----------------------------------------------------
// Health / whoami
// ----------------------------------------------------
app.get("/__whoami", (req, res) => {
  res.json({
    ok: true,
    now: new Date().toISOString(),
    env: process.env.NODE_ENV || "dev",
  });
});

// ----------------------------------------------------
// Auth
// ----------------------------------------------------
app.post("/auth/register", async (req, res) => {
  try {
    const { username, password, name, phone } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, message: "username/password 필요" });
    }

    const exists = await pool.query("SELECT id FROM users WHERE username = $1", [username]);
    if (exists.rows.length > 0) {
      return res.status(409).json({ success: false, message: "이미 존재하는 username" });
    }

    const pwHash = hashPassword(password);
    const r = await pool.query(
      `INSERT INTO users (username, password_hash, name, phone)
       VALUES ($1, $2, $3, $4)
       RETURNING id, username, name, phone`,
      [username, pwHash, name || null, phone || null]
    );

    res.json({ success: true, user: r.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/auth/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    const pwHash = hashPassword(password || "");

    const r = await pool.query(
      "SELECT id, username, name, phone FROM users WHERE username = $1 AND password_hash = $2",
      [username, pwHash]
    );

    if (r.rows.length === 0) {
      return res.status(401).json({ success: false, message: "로그인 실패" });
    }

    res.json({ success: true, user: r.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ----------------------------------------------------
// Products
// ----------------------------------------------------
app.get("/products", async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, name, price, image_url, created_at
       FROM products
       ORDER BY id DESC`
    );
    res.json({ success: true, products: r.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/products", async (req, res) => {
  try {
    const { name, price, image_url } = req.body;
    if (!name) return res.status(400).json({ success: false, message: "name 필요" });

    const r = await pool.query(
      `INSERT INTO products (name, price, image_url)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [name, parseAmount(price), image_url || null]
    );

    res.json({ success: true, product: r.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ----------------------------------------------------
// Orders
// ----------------------------------------------------
app.post("/orders", async (req, res) => {
  try {
    const { user_id, items } = req.body;
    if (!user_id || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: "user_id/items 필요" });
    }

    // 1) 주문 헤더 생성
    const head = await pool.query(
      `INSERT INTO orders (user_id, status, total_amount)
       VALUES ($1, 'PENDING', 0)
       RETURNING id`,
      [user_id]
    );
    const orderId = head.rows[0].id;

    // 2) 주문 아이템 추가 + 합계 계산
    let total = 0;
    for (const it of items) {
      const productId = Number(it.product_id);
      const qty = Number(it.qty || 1);

      const pr = await pool.query("SELECT id, price FROM products WHERE id = $1", [productId]);
      if (pr.rows.length === 0) continue;

      const unitPrice = parseAmount(pr.rows[0].price);
      const lineTotal = unitPrice * qty;
      total += lineTotal;

      await pool.query(
        `INSERT INTO order_items (order_id, product_id, qty, unit_price, line_total)
         VALUES ($1, $2, $3, $4, $5)`,
        [orderId, productId, qty, unitPrice, lineTotal]
      );
    }

    // 3) 주문 합계 업데이트
    await pool.query("UPDATE orders SET total_amount = $1 WHERE id = $2", [total, orderId]);

    res.json({ success: true, order_id: orderId, total_amount: total });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/orders/:id", async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    const head = await pool.query(
      `SELECT o.*, u.username, u.name
       FROM orders o
       JOIN users u ON u.id = o.user_id
       WHERE o.id = $1`,
      [orderId]
    );

    if (head.rows.length === 0) {
      return res.status(404).json({ success: false, message: "order 없음" });
    }

    const items = await pool.query(
      `SELECT oi.product_id, p.name, oi.qty, oi.unit_price, oi.line_total
       FROM order_items oi
       JOIN products p ON p.id = oi.product_id
       WHERE oi.order_id = $1
       ORDER BY oi.id ASC`,
      [orderId]
    );

    res.json({ success: true, order: head.rows[0], items: items.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ----------------------------------------------------
// Excel Upload (예시)
// ----------------------------------------------------
app.post("/admin/upload-excel", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: "file 필요" });
    const rows = readExcel(req.file.buffer);
    res.json({ success: true, rows_count: rows.length, rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ----------------------------------------------------
// IBK Router (✅ CommonJS로 연결)
// ----------------------------------------------------
const ibkRouter = require("./ibk");
app.use("/ibk", ibkRouter);
if (
  process.env.IBK_CLIENT_ID &&
  process.env.IBK_CLIENT_SECRET &&
  process.env.IBK_AUTH_URL &&
  process.env.IBK_TOKEN_URL
) {
  const ibkRouter = require("./ibk");
  app.use("/ibk", ibkRouter);
  console.log("✅ IBK router enabled");
} else {
  console.log("⚠️ IBK router disabled (env not set)");
}


// ----------------------------------------------------
// Static (SPA)
// ----------------------------------------------------
const distPath = path.join(__dirname, "dist");
app.use(express.static(distPath));

// SPA 라우팅 (API 경로 제외)
app.get(
  /^\/(?!auth|products|orders|head|wallet|topups|admin|profile|points|master|__whoami|ibk).*/,
  (req, res) => {
    res.sendFile(path.join(distPath, "index.html"));
  }
);

// ----------------------------------------------------
// Start
// ----------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 서버 실행 중: 포트 ${PORT}`));
