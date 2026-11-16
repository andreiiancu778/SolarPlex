require('dotenv').config();
const express = require('express');
const session = require('express-session');
const pool = require('./db');

const app = express();
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({ secret: 'solarplexus-secret', resave: false, saveUninitialized: true }));

// cart counter available in every view (header)
app.use((req, res, next) => {
  res.locals.nrCos = Object.values(req.session.cos || {}).reduce((s, c) => s + c, 0);
  next();
});

const CODU = 1; // TEMPORARY: logged-in user until login exists (stage 3)

app.locals.icon = (c) =>
  c === 'Panouri Fotovoltaice' ? '☀️' : c === 'Invertoare' ? '⚡' : c === 'Acumulatori' ? '🔋' : '📦';

// catches errors from async routes
const w = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => res.status(500).send('Error: ' + e.message));

// ---------- CUSTOMER PAGES ----------
app.get('/test', w(async (req, res) => {
  const r = await pool.query('SELECT COUNT(*) FROM produs');
  res.send('Connected! Products in database: ' + r.rows[0].count);
}));

// HOME: categories + popular products (JOIN, GROUP BY)
app.get('/', w(async (req, res) => {
  const categorii = await pool.query(
    `SELECT c.codcat, c.denumire, c.descriere, COUNT(p.codp) AS nr
     FROM categorie c LEFT JOIN produs p ON p.codcat = c.codcat
     GROUP BY c.codcat ORDER BY c.codcat`);
  const populare = await pool.query(
    `SELECT p.codp, p.den, p.putere, p.stoc, p.pret, c.denumire AS categorie,
            COALESCE(SUM(d.cant), 0) AS vandute
     FROM produs p
     LEFT JOIN categorie c ON p.codcat = c.codcat
     LEFT JOIN detalii_comanda d ON d.codp = p.codp
     GROUP BY p.codp, c.denumire
     ORDER BY vandute DESC, p.codp DESC LIMIT 4`);
  res.render('home', { categorii: categorii.rows, populare: populare.rows });
}));

// CATALOG: search, category filter, sorting
app.get('/catalog', w(async (req, res) => {
  const { cat, q, sort } = req.query;
  const params = [], where = [];
  if (cat) { params.push(cat); where.push(`p.codcat = $${params.length}`); }
  if (q) { params.push('%' + q + '%'); where.push(`p.den ILIKE $${params.length}`); }
  const orders = { nou: 'p.codp DESC', pret_asc: 'p.pret ASC', pret_desc: 'p.pret DESC',
                   putere_desc: 'p.putere DESC NULLS LAST' };
  const produse = await pool.query(
    `SELECT p.codp, p.den, p.putere, p.stoc, p.pret, c.denumire AS categorie
     FROM produs p LEFT JOIN categorie c ON p.codcat = c.codcat
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY ${orders[sort] || orders.nou}`, params);
  const categorii = await pool.query('SELECT * FROM categorie ORDER BY codcat');
  res.render('catalog', { produse: produse.rows, categorii: categorii.rows,
                          cat: cat || '', q: q || '', sort: sort || 'nou' });
}));

// PRODUCT DETAIL + reviews
app.get('/produs/:id', w(async (req, res) => {
  const prod = await pool.query(
    `SELECT p.*, c.denumire AS categorie FROM produs p
     LEFT JOIN categorie c ON p.codcat = c.codcat WHERE p.codp = $1`, [req.params.id]);
  if (!prod.rows.length) return res.status(404).send('Produsul nu există');
  const rec = await pool.query(
    `SELECT r.codrec, r.codu, r.rating, r.comentariu, u.nume
     FROM recenzii r JOIN utilizator u ON r.codu = u.codu
     WHERE r.codp = $1 ORDER BY r.codrec DESC`, [req.params.id]);
  const medie = rec.rows.length
    ? (rec.rows.reduce((s, r) => s + r.rating, 0) / rec.rows.length).toFixed(1) : null;
  res.render('produs', { produs: prod.rows[0], recenzii: rec.rows, medie, codu: CODU });
}));

// REVIEWS: create / delete
app.post('/produs/:id/recenzie', w(async (req, res) => {
  await pool.query('INSERT INTO recenzii (codp, codu, rating, comentariu) VALUES ($1, $2, $3, $4)',
    [req.params.id, CODU, req.body.rating, req.body.comentariu]);
  res.redirect('/produs/' + req.params.id);
}));
app.post('/recenzii/:id/sterge', w(async (req, res) => {
  const r = await pool.query('DELETE FROM recenzii WHERE codrec = $1 RETURNING codp', [req.params.id]);
  res.redirect(req.body.inapoi === 'admin' || !r.rows.length ? '/admin' : '/produs/' + r.rows[0].codp);
}));

// ---------- CART ----------
app.post('/cos/adauga/:id', w(async (req, res) => {
  const cant = parseInt(req.body.cant) || 1;
  const p = await pool.query('SELECT stoc FROM produs WHERE codp = $1', [req.params.id]);
  if (!p.rows.length) return res.status(404).send('Produsul nu există');
  if (p.rows[0].stoc < 1) return res.status(400).send('Stoc epuizat');
  const cos = req.session.cos || {};
  cos[req.params.id] = Math.min((cos[req.params.id] || 0) + cant, p.rows[0].stoc);
  req.session.cos = cos;
  res.redirect('/cos');
}));

app.get('/cos', w(async (req, res) => {
  const cos = req.session.cos || {};
  const ids = Object.keys(cos).map(Number);
  let linii = [], total = 0;
  if (ids.length) {
    const r = await pool.query(
      'SELECT codp, den, pret, stoc FROM produs WHERE codp = ANY($1::int[]) ORDER BY codp', [ids]);
    linii = r.rows.map((p) => {
      const cant = cos[p.codp], subtotal = Number(p.pret) * cant;
      total += subtotal;
      return { ...p, cant, subtotal };
    });
  }
  res.render('cos', { linii, total });
}));

app.post('/cos/sterge/:id', (req, res) => {
  const cos = req.session.cos || {};
  delete cos[req.params.id];
  req.session.cos = cos;
  res.redirect('/cos');
});

// PLACE ORDER: one transaction (stock check + comanda + detalii_comanda)
app.post('/cos/comanda', async (req, res) => {
  const cos = req.session.cos || {};
  const ids = Object.keys(cos);
  if (!ids.length) return res.redirect('/cos');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let total = 0;
    const linii = [];
    for (const id of ids) {
      const r = await client.query(
        'UPDATE produs SET stoc = stoc - $1 WHERE codp = $2 AND stoc >= $1 RETURNING pret',
        [cos[id], id]);
      if (!r.rowCount) throw new Error('Stoc insuficient pentru produsul ' + id);
      const pret = Number(r.rows[0].pret);
      total += pret * cos[id];
      linii.push({ id, cant: cos[id], pret });
    }
    const com = await client.query(
      'INSERT INTO comanda (codu, valoare) VALUES ($1, $2) RETURNING codcom', [CODU, total.toFixed(2)]);
    for (const l of linii) {
      await client.query(
        'INSERT INTO detalii_comanda (codcom, codp, cant, pret_unitar) VALUES ($1, $2, $3, $4)',
        [com.rows[0].codcom, l.id, l.cant, l.pret]);
    }
    await client.query('COMMIT');
    req.session.cos = {};
    res.redirect('/cont');
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).send('Eroare la plasarea comenzii: ' + e.message);
  } finally {
    client.release();
  }
});

// ---------- MY ACCOUNT ----------
app.get('/cont', w(async (req, res) => {
  const user = await pool.query('SELECT codu, nume, email FROM utilizator WHERE codu = $1', [CODU]);
  const com = await pool.query('SELECT * FROM comanda WHERE codu = $1 ORDER BY data_comanda DESC', [CODU]);
  const det = await pool.query(
    `SELECT d.codcom, d.cant, d.pret_unitar, p.den
     FROM detalii_comanda d LEFT JOIN produs p ON d.codp = p.codp
     WHERE d.codcom = ANY($1::int[])`, [com.rows.map((c) => c.codcom)]);
  const comenzi = com.rows.map((c) => ({ ...c, produse: det.rows.filter((d) => d.codcom === c.codcom) }));
  res.render('cont', { user: user.rows[0], comenzi });
}));

// ---------- ADMIN DASHBOARD ----------
app.get('/admin', w(async (req, res) => {
  const stats = await pool.query(
    `SELECT (SELECT COUNT(*) FROM produs) AS produse,
            (SELECT COUNT(*) FROM comanda) AS comenzi,
            (SELECT COUNT(*) FROM utilizator) AS utilizatori,
            (SELECT COALESCE(SUM(valoare), 0) FROM comanda) AS vanzari`);
  const comenzi = await pool.query(
    `SELECT c.codcom, c.data_comanda, c.status, c.valoare, u.nume
     FROM comanda c LEFT JOIN utilizator u ON c.codu = u.codu ORDER BY c.data_comanda DESC LIMIT 15`);
  const stocMic = await pool.query('SELECT codp, den, stoc FROM produs WHERE stoc < 10 ORDER BY stoc');
  const categorii = await pool.query(
    `SELECT c.*, COUNT(p.codp) AS nr FROM categorie c
     LEFT JOIN produs p ON p.codcat = c.codcat GROUP BY c.codcat ORDER BY c.codcat`);
  const recenzii = await pool.query(
    `SELECT r.codrec, r.rating, r.comentariu, u.nume, p.den
     FROM recenzii r JOIN utilizator u ON r.codu = u.codu JOIN produs p ON r.codp = p.codp
     ORDER BY r.codrec DESC LIMIT 10`);
  res.render('admin', { s: stats.rows[0], comenzi: comenzi.rows, stocMic: stocMic.rows,
                        categorii: categorii.rows, recenzii: recenzii.rows });
}));

// order status: UPDATE
app.post('/admin/comanda/:id/status', w(async (req, res) => {
  await pool.query('UPDATE comanda SET status = $1 WHERE codcom = $2', [req.body.status, req.params.id]);
  res.redirect('/admin');
}));

// categories: CREATE / UPDATE / DELETE
app.post('/admin/categorii', w(async (req, res) => {
  await pool.query('INSERT INTO categorie (denumire, descriere) VALUES ($1, $2)',
    [req.body.denumire, req.body.descriere]);
  res.redirect('/admin');
}));
app.post('/admin/categorii/:id', w(async (req, res) => {
  await pool.query('UPDATE categorie SET denumire = $1, descriere = $2 WHERE codcat = $3',
    [req.body.denumire, req.body.descriere, req.params.id]);
  res.redirect('/admin');
}));
app.post('/admin/categorii/:id/sterge', w(async (req, res) => {
  await pool.query('DELETE FROM categorie WHERE codcat = $1', [req.params.id]);
  res.redirect('/admin');
}));

// ---------- ADMIN: PRODUCT CRUD ----------
app.get('/produse', w(async (req, res) => {
  const r = await pool.query(
    `SELECT p.codp, p.den, p.putere, p.stoc, p.pret, c.denumire AS categorie
     FROM produs p LEFT JOIN categorie c ON p.codcat = c.codcat ORDER BY p.codp`);
  res.render('produse/index', { produse: r.rows });
}));
app.get('/produse/nou', w(async (req, res) => {
  const c = await pool.query('SELECT * FROM categorie ORDER BY denumire');
  res.render('produse/form', { produs: null, categorii: c.rows });
}));
app.post('/produse', w(async (req, res) => {
  const { codcat, den, putere, stoc, pret } = req.body;
  await pool.query('INSERT INTO produs (codcat, den, putere, stoc, pret) VALUES ($1, $2, $3, $4, $5)',
    [codcat, den, putere || null, stoc, pret]);
  res.redirect('/produse');
}));
app.get('/produse/:id/edit', w(async (req, res) => {
  const p = await pool.query('SELECT * FROM produs WHERE codp = $1', [req.params.id]);
  if (!p.rows.length) return res.status(404).send('Product not found');
  const c = await pool.query('SELECT * FROM categorie ORDER BY denumire');
  res.render('produse/form', { produs: p.rows[0], categorii: c.rows });
}));
app.post('/produse/:id', w(async (req, res) => {
  const { codcat, den, putere, stoc, pret } = req.body;
  await pool.query(
    'UPDATE produs SET codcat = $1, den = $2, putere = $3, stoc = $4, pret = $5 WHERE codp = $6',
    [codcat, den, putere || null, stoc, pret, req.params.id]);
  res.redirect('/produse');
}));
app.post('/produse/:id/sterge', w(async (req, res) => {
  await pool.query('DELETE FROM produs WHERE codp = $1', [req.params.id]);
  res.redirect('/produse');
}));

app.listen(3000, () => console.log('Server running on http://localhost:3000'));
