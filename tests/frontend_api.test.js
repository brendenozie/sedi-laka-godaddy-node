const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/app');
const { getDb } = require('../src/db');
const { seedDatabase } = require('../src/db/seed');

describe('Category F: HTTP Endpoints, Visual Routing, and Health Verification', () => {
  let server = null;
  let baseUrl = '';

  before(async () => {
    getDb();
    seedDatabase();
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('System Health: GET /health returns 200 with healthy database and memory statistics', async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'healthy');
    assert.equal(body.database.status, 'ok');
    assert.ok(body.uptimeSeconds >= 0);
  });

  test('Public Landing Page: GET / serves original HTML with intact visual identity', async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    const html = await res.text();

    assert.ok(html.includes('Sedi Laka Center | Awaken Your Light'), 'Title preserved');
    assert.ok(html.includes('Make room for a way forward.'), 'Hero copy preserved');
    assert.ok(html.includes('The Sedi Laka approach'), 'Approach section preserved');
    assert.ok(html.includes('Sarah Kihuha'), 'Founder introduction preserved');
    assert.ok(html.includes('Exploration Session'), 'Exploration session preserved');
    assert.ok(html.includes('Clarity Package'), 'Clarity package preserved');
    assert.ok(html.includes('Integration Package'), 'Integration package preserved');
    assert.ok(html.includes('Vision Board Experience'), 'Vision board content preserved');
    assert.ok(html.includes('sedilaka.org@gmail.com'), 'Email contact & fallback preserved');
  });

  test('Portal Routing: GET /portal serves client portal interface', async () => {
    const res = await fetch(`${baseUrl}/portal`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('Client Portal · Sedi Laka Center'));
  });

  test('Admin Routing: GET /admin serves staff/admin dashboard interface', async () => {
    const res = await fetch(`${baseUrl}/admin`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('Administrative Dashboard · Sedi Laka Center'));
  });

  test('Checkout Routing: GET /checkout serves secure checkout interface', async () => {
    const res = await fetch(`${baseUrl}/checkout`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('Secure Checkout'));
  });

  test('Public Catalog: GET /api/services returns active services with accurate pricing', async () => {
    const res = await fetch(`${baseUrl}/api/services`);
    assert.equal(res.status, 200);
    const { services } = await res.json();
    assert.ok(services.length >= 3);

    const exploration = services.find(s => s.id === 'srv-exploration-session');
    assert.equal(exploration.price_usd, 100);

    const clarity = services.find(s => s.id === 'srv-clarity-package');
    assert.equal(clarity.price_usd, 475);
    assert.equal(clarity.session_count, 5);

    const integration = services.find(s => s.id === 'srv-integration-package');
    assert.equal(integration.price_usd, 900);
    assert.equal(integration.session_count, 10);
  });
});
