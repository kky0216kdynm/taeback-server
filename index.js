require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const cors = require('cors');

const app = express();

// 미들웨어 설정
app.use(express.json());
app.use(cors());

// ----------------------------------------------------
// 1. 데이터베이스 연결 (Cloudtype / Render 공용)
// ----------------------------------------------------
// .env 파일이나 Cloudtype 환경변수에 DATABASE_URL이 있어야 합니다.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // 클라우드 DB 사용 시 필수
});

pool.connect()
  .then(() => console.log('✅ DB 연결 성공!'))
  .catch(err => console.error('❌ DB 연결 실패:', err.message));

// ----------------------------------------------------
// 2. API 엔드포인트 (새로운 2단계 인증 로직)
// ----------------------------------------------------

// [1단계] 본사 코드 확인 -> 지점 목록 반환
app.post('/auth/verify-head', async (req, res) => {
  const { inviteCode } = req.body;
  console.log(`[본사 인증] 코드: ${inviteCode}`);

  try {
    // 본사 찾기
    const headRes = await pool.query('SELECT id, name FROM head_offices WHERE code = $1', [inviteCode]);
    if (headRes.rows.length === 0) return res.status(404).json({ success: false, message: '본사 코드가 틀렸습니다.' });

    const headOffice = headRes.rows[0];

    // 지점 목록 조회 (가맹점 코드는 보안상 안 보냄)
    const branchesRes = await pool.query('SELECT id, name, address FROM stores WHERE head_office_id = $1 ORDER BY name ASC', [headOffice.id]);

    res.json({ success: true, headOffice, branches: branchesRes.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// [2단계] 가맹점 로그인 (지점ID + 가맹점 코드)
app.post('/auth/login-store', async (req, res) => {
  const { storeId, merchantCode } = req.body;
  console.log(`[가맹점 로그인] ID: ${storeId}, 코드: ${merchantCode}`);

  try {
    // 가맹점 코드 확인
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

// [상품 조회]
app.get('/products', async (req, res) => {
  const { headOfficeId } = req.query;
  try {
    const result = await pool.query('SELECT * FROM products WHERE head_office_id = $1 ORDER BY id DESC', [headOfficeId]);
    res.json({ success: true, products: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ----------------------------------------------------
// 3. 서버 실행
// ----------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 서버 실행 중: 포트 ${PORT}`);
});