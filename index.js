require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();

app.use(express.json());
app.use(cors());

// ----------------------------------------------------
// ✅ 핵심: DATABASE_URL 하나로 연결하기
// ----------------------------------------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false   // ⭐ 중요: Cloudtype 내부 Postgres는 SSL ❌
});

// DB 연결 확인 로그
pool.connect()
  .then(() => console.log('✅ DB 연결 성공!'))
  .catch(err => console.error('❌ DB 연결 실패:', err.message));


// ----------------------------------------------------
// API 엔드포인트
// ----------------------------------------------------

// 1. 본사 인증
app.post('/auth/verify-head', async (req, res) => {
  const { inviteCode } = req.body;
  try {
    const headRes = await pool.query('SELECT id, name FROM head_offices WHERE code = $1', [inviteCode]);
    if (headRes.rows.length === 0) return res.status(404).json({ success: false, message: '본사 코드가 틀렸습니다.' });
    
    const headOffice = headRes.rows[0];
    const branchesRes = await pool.query('SELECT id, name, address FROM stores WHERE head_office_id = $1 ORDER BY name ASC', [headOffice.id]);

    res.json({ success: true, headOffice, branches: branchesRes.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. 가맹점 로그인
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
    const result = await pool.query('SELECT * FROM products WHERE head_office_id = $1 ORDER BY id DESC', [headOfficeId]);
    res.json({ success: true, products: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 서버 실행
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 서버 실행 중: 포트 ${PORT}`);
});