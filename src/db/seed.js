const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getDb } = require('./index');
const { hashPassword } = require('../services/authService');
const config = require('../config');

function seedDatabase() {
  const db = getDb();
  const now = new Date().toISOString();

  // 1. Initial Admin User
  const adminExists = db.prepare('SELECT id FROM users WHERE email = ?').get(config.INITIAL_ADMIN_EMAIL.toLowerCase());
  if (!adminExists) {
    const { hash, salt } = hashPassword(config.INITIAL_ADMIN_PASSWORD);
    const adminId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO users (
        id, email, password_hash, password_salt, full_name, phone, role,
        email_verified, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'Sarah Kihuha (Admin)', '+254700000000', 'admin', 1, ?, ?)
    `).run(adminId, config.INITIAL_ADMIN_EMAIL.toLowerCase(), hash, salt, now, now);
    console.log(`[Seed] Created initial administrator: ${config.INITIAL_ADMIN_EMAIL}`);
  }

  // 2. Services Catalog (Exploration Session $100, Clarity Package $475, Integration Package $900)
  const services = [
    {
      id: 'srv-exploration-session',
      name: 'Exploration Session',
      slug: 'exploration-session',
      type: 'single_session',
      description: 'A first private session to explore your situation and decide together what comes next.',
      duration_minutes: 50,
      price_usd: 100.00,
      session_count: 1
    },
    {
      id: 'srv-clarity-package',
      name: 'Clarity Package',
      slug: 'clarity-package',
      type: 'package',
      description: 'Five weekly private sessions to make space for understanding and focused work.',
      duration_minutes: 50,
      price_usd: 475.00,
      session_count: 5
    },
    {
      id: 'srv-integration-package',
      name: 'Integration Package',
      slug: 'integration-package',
      type: 'package',
      description: 'Ten private sessions over a maximum of three months for sustained work and integration.',
      duration_minutes: 50,
      price_usd: 900.00,
      session_count: 10
    }
  ];

  for (const s of services) {
    const exists = db.prepare('SELECT id FROM services WHERE id = ?').get(s.id);
    if (!exists) {
      db.prepare(`
        INSERT INTO services (id, name, slug, type, description, duration_minutes, price_usd, session_count, is_active, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      `).run(s.id, s.name, s.slug, s.type, s.description, s.duration_minutes, s.price_usd, s.session_count, now);
    }
  }

  // 3. Weekly Working Schedule (Mon-Fri 09:00-17:00, Sat 10:00-14:00, Sun off)
  const schedules = [
    { day: 0, start: '09:00', end: '17:00', working: 0 }, // Sun
    { day: 1, start: '09:00', end: '17:00', working: 1 }, // Mon
    { day: 2, start: '09:00', end: '17:00', working: 1 }, // Tue
    { day: 3, start: '09:00', end: '17:00', working: 1 }, // Wed
    { day: 4, start: '09:00', end: '17:00', working: 1 }, // Thu
    { day: 5, start: '09:00', end: '17:00', working: 1 }, // Fri
    { day: 6, start: '10:00', end: '14:00', working: 1 }  // Sat
  ];

  for (const sch of schedules) {
    const exists = db.prepare('SELECT id FROM schedule_config WHERE day_of_week = ?').get(sch.day);
    if (!exists) {
      db.prepare(`
        INSERT INTO schedule_config (day_of_week, start_time, end_time, is_working_day, slot_interval_minutes, buffer_minutes)
        VALUES (?, ?, ?, ?, 60, 15)
      `).run(sch.day, sch.start, sch.end, sch.working);
    }
  }

  // 4. Initial Events (e.g. Vision Board Experience, Quarterly Retreat)
  const events = [
    {
      id: 'evt-vision-board-brunch',
      title: 'Vision Board Experience — Opening Brunch',
      slug: 'vision-board-experience-opening-brunch',
      description: 'A guided gathering to shape your vision for the year with mutual encouragement. Small, intimate circle capped strictly at 15 participants.',
      start_time: '2027-01-16T07:00:00Z', // 10:00 AM EAT
      end_time: '2027-01-16T11:00:00Z',   // 2:00 PM EAT
      timezone: 'Africa/Nairobi',
      venue: 'Sedi Laka Garden Sanctuary, Nairobi & Online Hybrid',
      delivery_mode: 'hybrid',
      capacity: 15,
      price_usd: 75.00,
      currency: 'USD',
      status: 'published'
    },
    {
      id: 'evt-quarterly-retreat',
      title: 'Quarterly Reflection & Renewal Retreat',
      slug: 'quarterly-reflection-and-renewal-retreat',
      description: 'A half-day intentional pause to notice what you are carrying, align your intentions, and practice restorative mindfulness.',
      start_time: '2027-03-20T06:30:00Z',
      end_time: '2027-03-20T10:30:00Z',
      timezone: 'Africa/Nairobi',
      venue: 'Online via Secure Live Room',
      delivery_mode: 'online',
      capacity: 25,
      price_usd: 50.00,
      currency: 'USD',
      status: 'published'
    }
  ];

  for (const e of events) {
    const exists = db.prepare('SELECT id FROM events WHERE id = ?').get(e.id);
    if (!exists) {
      db.prepare(`
        INSERT INTO events (
          id, title, slug, description, start_time, end_time, timezone,
          venue, delivery_mode, capacity, price_usd, currency, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        e.id, e.title, e.slug, e.description, e.start_time, e.end_time, e.timezone,
        e.venue, e.delivery_mode, e.capacity, e.price_usd, e.currency, e.status, now, now
      );
    }
  }

  // 5. Digital Resources & sample files
  if (!fs.existsSync(config.RESOURCES_DIR)) {
    fs.mkdirSync(config.RESOURCES_DIR, { recursive: true });
  }

  const samplePlannerPath = path.join(config.RESOURCES_DIR, 'sedi_laka_intentional_planner.pdf');
  if (!fs.existsSync(samplePlannerPath)) {
    fs.writeFileSync(samplePlannerPath, '%PDF-1.4\n% Sedi Laka Center Intentional Planner Guide\n');
  }

  const sampleJournalPath = path.join(config.RESOURCES_DIR, 'sedi_laka_reflective_journal.pdf');
  if (!fs.existsSync(sampleJournalPath)) {
    fs.writeFileSync(sampleJournalPath, '%PDF-1.4\n% Sedi Laka Center Reflective Journal\n');
  }

  const sampleAudioPath = path.join(config.RESOURCES_DIR, 'sedi_laka_grounding_session.mp3');
  if (!fs.existsSync(sampleAudioPath)) {
    fs.writeFileSync(sampleAudioPath, 'ID3\x03\x00\x00\x00\x00\x00Sedi Laka Grounding Audio');
  }

  const resources = [
    {
      id: 'res-intentional-planner',
      title: 'Intentional Living & Quarterly Planner',
      slug: 'intentional-living-quarterly-planner',
      category: 'planners',
      description: 'A printable, structure-focused guide to help you pause, break down overwhelming commitments, and design weekly restorative rhythms.',
      file_filename: 'sedi_laka_intentional_planner.pdf',
      file_path: samplePlannerPath,
      file_size_bytes: 48200,
      mime_type: 'application/pdf',
      price_usd: 0.00,
      is_free: 1
    },
    {
      id: 'res-reflective-journal',
      title: 'From Overwhelm to Clarity: Guided Reflection Journal',
      slug: 'from-overwhelm-to-clarity-journal',
      category: 'reflective_guides',
      description: 'Carefully phrased introspective prompts designed by Sarah Kihuha to explore what you are carrying without self-judgment.',
      file_filename: 'sedi_laka_reflective_journal.pdf',
      file_path: sampleJournalPath,
      file_size_bytes: 52400,
      mime_type: 'application/pdf',
      price_usd: 0.00,
      is_free: 1
    },
    {
      id: 'res-grounding-audio',
      title: 'Somatic Grounding & Breathwork Audio Guide',
      slug: 'somatic-grounding-audio-guide',
      category: 'audio_guides',
      description: 'A 20-minute guided audio sanctuary session to regulate the nervous system when facing emotional overwhelm.',
      file_filename: 'sedi_laka_grounding_session.mp3',
      file_path: sampleAudioPath,
      file_size_bytes: 18450000,
      mime_type: 'audio/mpeg',
      price_usd: 15.00,
      is_free: 0
    }
  ];

  for (const r of resources) {
    const exists = db.prepare('SELECT id FROM resources WHERE id = ?').get(r.id);
    if (!exists) {
      db.prepare(`
        INSERT INTO resources (
          id, title, slug, category, description, file_filename,
          file_path, file_size_bytes, mime_type, price_usd, is_free, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?)
      `).run(
        r.id, r.title, r.slug, r.category, r.description, r.file_filename,
        r.file_path, r.file_size_bytes, r.mime_type, r.price_usd, r.is_free, now
      );
    }
  }

  console.log('[Seed] Database initialization and seed completed successfully.');
}

module.exports = { seedDatabase };
