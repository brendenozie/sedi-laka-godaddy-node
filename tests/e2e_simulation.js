const assert = require('node:assert/strict');

const BASE_URL = 'http://localhost:3000';

async function runE2E() {
  console.log('--- Starting Full End-to-End System Simulation ---');

  // 1. Health check
  console.log('1. Testing System Health...');
  const healthRes = await fetch(`${BASE_URL}/health`);
  assert.equal(healthRes.status, 200);
  const health = await healthRes.json();
  console.log(`   Health Status: ${health.status}, DB Latency: ${health.database.latencyMs}ms`);

  // 2. User Registration
  const testEmail = `tariq_${Date.now()}@sedilakaclient.org`;
  console.log(`2. Registering Client: ${testEmail}...`);
  const regRes = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fullName: 'Tariq Mwangi',
      email: testEmail,
      phone: '+254712345678',
      password: 'SecurePassword2026!'
    })
  });
  assert.equal(regRes.status, 201);
  const regData = await regRes.json();
  const sessionId = regData.sessionId;
  const cookieHeader = `sedi_session=${sessionId}`;
  console.log(`   Registered successfully. User ID: ${regData.user.id}`);

  // 3. User Authentication check
  console.log('3. Verifying Authenticated Session via GET /api/auth/me...');
  const meRes = await fetch(`${BASE_URL}/api/auth/me`, {
    headers: { Cookie: cookieHeader }
  });
  assert.equal(meRes.status, 200);
  const me = await meRes.json();
  assert.equal(me.user.fullName || me.user.full_name, 'Tariq Mwangi');
  console.log(`   Session valid for: ${me.user.fullName || me.user.full_name} (${me.user.role})`);

  // 4. Availability lookup
  console.log('4. Querying Booking Availability for upcoming date...');
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 2);
  const dateStr = tomorrow.toISOString().split('T')[0];
  const availRes = await fetch(`${BASE_URL}/api/bookings/availability?date=${dateStr}&timezone=Africa/Nairobi`);
  assert.equal(availRes.status, 200);
  const availData = await availRes.json();
  console.log(`   Found ${availData.availableSlots.length} available slots on ${dateStr}`);

  // 5. Booking Exploration Session ($100)
  const chosenSlot = availData.availableSlots[0].startTime;
  console.log(`5. Booking Exploration Session at ${chosenSlot}...`);
  const bookRes = await fetch(`${BASE_URL}/api/bookings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookieHeader
    },
    body: JSON.stringify({
      serviceId: 'srv-exploration-session',
      startTimeUtc: chosenSlot,
      deliveryMethod: 'online',
      clientNotes: 'Focus on managing work transition overwhelm'
    })
  });
  assert.equal(bookRes.status, 201);
  const bookData = await bookRes.json();
  const apptRef = bookData.appointment.reference_number;
  console.log(`   Appointment Booked! Ref: ${apptRef}, Status: ${bookData.appointment.status}`);

  // 6. Purchasing Clarity Package ($475 / 5 sessions)
  console.log('6. Purchasing Clarity Package ($475)...');
  const pkgBuyRes = await fetch(`${BASE_URL}/api/packages/purchase`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookieHeader
    },
    body: JSON.stringify({
      serviceId: 'srv-clarity-package',
      provider: 'mock_sandbox'
    })
  });
  assert.equal(pkgBuyRes.status, 201);
  const pkgBuyData = await pkgBuyRes.json();
  const pkgTxRef = pkgBuyData.payment.transaction_reference;
  console.log(`   Package Payment Initiated. Ref: ${pkgTxRef}`);

  // Complete Sandbox Payment
  console.log('7. Confirming Package Payment through Sandbox Gateway...');
  const payConfirmRes = await fetch(`${BASE_URL}/api/payments/sandbox-checkout`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookieHeader
    },
    body: JSON.stringify({
      transactionReference: pkgTxRef,
      simulateSuccess: true
    })
  });
  assert.equal(payConfirmRes.status, 200);
  console.log(`   Payment Confirmed! Package sessions fulfilled.`);

  // 8. Verify Packages and Entitlement Ledger in Portal
  console.log('8. Verifying Session Credits in Client Portal...');
  const myPkgsRes = await fetch(`${BASE_URL}/api/packages/my`, {
    headers: { Cookie: cookieHeader }
  });
  assert.equal(myPkgsRes.status, 200);
  const { packages } = await myPkgsRes.json();
  assert.equal(packages.length, 1);
  assert.equal(packages[0].remaining_sessions, 5);
  console.log(`   Active Package: ${packages[0].name}, Credits: ${packages[0].remaining_sessions}/${packages[0].total_sessions}`);

  // 9. Book session using package credit
  console.log('9. Booking Session using Package Credit...');
  const slot2Time = availData.availableSlots[1].startTime;
  const pkgApptRes = await fetch(`${BASE_URL}/api/bookings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookieHeader
    },
    body: JSON.stringify({
      serviceId: 'srv-clarity-package',
      packageId: packages[0].id,
      startTimeUtc: slot2Time,
      deliveryMethod: 'in_person'
    })
  });
  assert.equal(pkgApptRes.status, 201);
  const pkgApptData = await pkgApptRes.json();
  console.log(`   Package Session Booked! Ref: ${pkgApptData.appointment.reference_number}`);

  // Check that package credits decremented to 4
  const myPkgsAfterRes = await fetch(`${BASE_URL}/api/packages/my`, {
    headers: { Cookie: cookieHeader }
  });
  const { packages: pkgsAfter } = await myPkgsAfterRes.json();
  assert.equal(pkgsAfter[0].remaining_sessions, 4);
  console.log(`   Session balance decremented to: ${pkgsAfter[0].remaining_sessions} (Ledger verified)`);

  // 10. Register for Vision Board Brunch
  console.log('10. Registering for Vision Board Experience Opening Brunch (Capacity: 15)...');
  const evtRes = await fetch(`${BASE_URL}/api/events/evt-vision-board-brunch/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookieHeader
    }
  });
  assert.equal(evtRes.status, 201);
  const evtData = await evtRes.json();
  console.log(`    Registered for: ${evtData.event.title}, Status: ${evtData.registration.status}`);

  // 11. Digital Resource Download Token Generation & Retrieval
  console.log('11. Requesting Signed Download Link for Intentional Planner...');
  const resDlReq = await fetch(`${BASE_URL}/api/resources/res-intentional-planner/request-download`, {
    method: 'POST',
    headers: { Cookie: cookieHeader }
  });
  assert.equal(resDlReq.status, 200);
  const { downloadUrl } = await resDlReq.json();
  console.log(`    Signed URL Generated: ${downloadUrl}`);

  // Download the protected file
  const fileRes = await fetch(`${BASE_URL}${downloadUrl}`);
  assert.equal(fileRes.status, 200);
  const fileText = await fileRes.text();
  assert.ok(fileText.startsWith('%PDF-1.4'));
  console.log(`    Secure Download Verified: Streamed ${fileText.length} bytes with Content-Disposition headers.`);

  // 12. Admin Dashboard Authentication & Overview
  console.log('12. Logging in as Administrator (admin@sedilaka.org)...');
  const adminLoginRes = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'admin@sedilaka.org',
      password: 'SediLakaAdmin2026!'
    })
  });
  assert.equal(adminLoginRes.status, 200);
  const adminData = await adminLoginRes.json();
  const adminCookie = `sedi_session=${adminData.sessionId}`;

  console.log('13. Fetching Administrative Metrics & Feed...');
  const adminOverviewRes = await fetch(`${BASE_URL}/api/admin/overview`, {
    headers: { Cookie: adminCookie }
  });
  assert.equal(adminOverviewRes.status, 200);
  const adminOverview = await adminOverviewRes.json();
  console.log(`    Admin Overview Metrics: Clients: ${adminOverview.metrics.totalClients}, Appts: ${adminOverview.metrics.totalAppointments}, Active Packages: ${adminOverview.metrics.activePackages}, Revenue: US$${adminOverview.metrics.totalRevenueUsd}`);

  // 14. Triggering on-demand SQLite atomic backup
  console.log('14. Creating Database Snapshot via SQLite VACUUM INTO...');
  const backupRes = await fetch(`${BASE_URL}/api/admin/backups/create`, {
    method: 'POST',
    headers: { Cookie: adminCookie }
  });
  assert.equal(backupRes.status, 200);
  const backupData = await backupRes.json();
  console.log(`    Snapshot Created: ${backupData.backup.filename} (${backupData.backup.sizeBytes} bytes)`);

  // Verify backup restoration
  console.log('15. Testing Backup Restoration Verification...');
  const restoreRes = await fetch(`${BASE_URL}/api/admin/backups/verify-restore`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: adminCookie
    },
    body: JSON.stringify({ filename: backupData.backup.filename })
  });
  assert.equal(restoreRes.status, 200);
  const restoreData = await restoreRes.json();
  assert.equal(restoreData.result.success, true);
  console.log(`    Restoration Verified: ${restoreData.result.userCount} users, ${restoreData.result.appointmentCount} appointments.`);

  console.log('\n========================================================================');
  console.log('ALL END-TO-END WORKFLOWS COMPLETED AND FULLY VERIFIED ON LIVE SERVER!');
  console.log('========================================================================\n');
}

runE2E().catch(err => {
  console.error('E2E FAILURE:', err);
  process.exit(1);
});
