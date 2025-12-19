require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');

const app = express();

app.use(express.json());
app.use(cors());

// ----------------------------------------------------
// ✅ DATABASE_URL 하나로 연결
// ----------------------------------------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false
});

pool.connect()
  .then(() => console.log('✅ DB 연결 성공!'))
  .catch(err => console.error('❌ DB 연결 실패:', err.message));

// ----------------------------------------------------
// ✅ API 엔드포인트
// ----------------------------------------------------

// 1. 본사 인증
app.post('/auth/verify-head', async (req, res) => {
  const { inviteCode } = req.body;
  try {
    const headRes = await pool.query(
      'SELECT id, name FROM head_offices WHERE code = $1',
      [inviteCode]
    );

    if (headRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: '본사 코드가 틀렸습니다.' });
    }

    const headOffice = headRes.rows[0];
    const branchesRes = await pool.query(
      'SELECT id, name, address FROM stores WHERE head_office_id = $1 ORDER BY name ASC',
      [headOffice.id]
    );

    res.json({ success: true, headOffice, branches: branchesRes.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. 가맹점 로그인(지점id+가맹코드)
app.post('/auth/login-store', async (req, res) => {
  const { storeId, merchantCode } = req.body;
  try {
    const resStore = await pool.query(
      'SELECT id, name, head_office_id, status FROM stores WHERE id = $1 AND merchant_code = $2',
      [storeId, merchantCode]
    );

    if (resStore.rows.length > 0) {
      res.json({ success: true, message: '로그인 성공', store: resStore.rows[0] });
    } else {
      res.status(401).json({ success: false, message: '가맹점 코드가 일치하지 않습니다.' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. 상품 조회
app.get('/products', async (req, res) => {
  const { headOfficeId } = req.query;
  try {
    const result = await pool.query(
      'SELECT * FROM products WHERE head_office_id = $1 ORDER BY id DESC',
      [headOfficeId]
    );
    res.json({ success: true, products: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. 가맹점 코드만으로 로그인
app.post('/auth/login-store-by-code', async (req, res) => {
  const { merchantCode } = req.body;

  try {
    const result = await pool.query(
      `SELECT id, head_office_id, name, business_no, phone, status, created_at
       FROM stores
       WHERE merchant_code = $1
       LIMIT 1`,
      [merchantCode]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, message: '가맹점 코드가 일치하지 않습니다.' });
    }

    return res.json({ success: true, message: '로그인 성공', store: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 5. 주문 생성
app.post('/orders', async (req, res) => {
  const { storeId, items } = req.body;

  if (!storeId || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: 'storeId/items 필요' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const storeRes = await client.query(
      'SELECT id, head_office_id FROM stores WHERE id = $1',
      [storeId]
    );
    if (storeRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'store 없음' });
    }
    const headOfficeId = storeRes.rows[0].head_office_id;

    const productIds = items.map(i => i.productId);
    const productsRes = await client.query(
      `SELECT id, price
       FROM products
       WHERE id = ANY($1::int[])
         AND head_office_id = $2`,
      [productIds, headOfficeId]
    );

    const priceMap = new Map(productsRes.rows.map(p => [p.id, p.price]));

    let total = 0;
    for (const it of items) {
      const price = priceMap.get(it.productId);
      if (price == null) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: `상품 불일치: ${it.productId}` });
      }
      total += price * it.qty;
    }

    const orderRes = await client.query(
      `INSERT INTO orders (store_id, head_office_id, status, total_amount)
       VALUES ($1, $2, 'pending', $3)
       RETURNING id`,
      [storeId, headOfficeId, total]
    );
    const orderId = orderRes.rows[0].id;

    for (const it of items) {
      const price = priceMap.get(it.productId);
      const lineTotal = price * it.qty;
      await client.query(
        `INSERT INTO order_items (order_id, product_id, qty, unit_price, line_total)
         VALUES ($1, $2, $3, $4, $5)`,
        [orderId, it.productId, it.qty, price, lineTotal]
      );
    }

    await client.query('COMMIT');
    return res.json({ success: true, orderId });
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// 6. 본사: 주문목록
app.get('/head/orders', async (req, res) => {
  const { headOfficeId, status } = req.query;
  if (!headOfficeId) return res.status(400).json({ success:false, message:'headOfficeId 필요' });

  try {
    const params = [headOfficeId];
    let where = 'WHERE o.head_office_id = $1';
    if (status) {
      params.push(status);
      where += ` AND o.status = $2`;
    }

    const result = await pool.query(
      `SELECT o.id, o.store_id, s.name AS store_name, o.status, o.total_amount, o.created_at
       FROM orders o
       JOIN stores s ON s.id = o.store_id
       ${where}
       ORDER BY o.id DESC`,
      params
    );

    res.json({ success:true, orders: result.rows });
  } catch (err) {
    res.status(500).json({ success:false, error: err.message });
  }
});

// 7. 본사: 주문 상세
app.get('/head/orders/:orderId', async (req, res) => {
  const { orderId } = req.params;

  try {
    const head = await pool.query(
      `SELECT o.id, o.store_id, s.name AS store_name, o.head_office_id, o.status, o.total_amount, o.created_at
       FROM orders o
       JOIN stores s ON s.id = o.store_id
       WHERE o.id = $1`,
      [orderId]
    );
    if (head.rows.length === 0) return res.status(404).json({ success:false, message:'order 없음' });

    const items = await pool.query(
      `SELECT oi.product_id, p.name, oi.qty, oi.unit_price, oi.line_total
       FROM order_items oi
       JOIN products p ON p.id = oi.product_id
       WHERE oi.order_id = $1
       ORDER BY oi.id ASC`,
      [orderId]
    );

    res.json({ success:true, order: head.rows[0], items: items.rows });
  } catch (err) {
    res.status(500).json({ success:false, error: err.message });
  }
});




// 서버 실행
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 서버 실행 중: 포트 ${PORT}`);
});
// ----------------------------------------------------
// ✅ 여기부터 "React 정적 파일" 서빙 (맨 아래!!!)
// ----------------------------------------------------

app.use(express.static(path.join(__dirname, 'admin', 'dist')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'dist', 'index.html'));
});