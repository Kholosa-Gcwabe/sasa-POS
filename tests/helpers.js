// Shared helpers. Credentials come from environment variables so they are never committed.
// Use a TEST Supabase project (see docs/test-cases.md, section "Test environment").
const { expect } = require('@playwright/test');

const USERS = {
  admin:   { user: process.env.SASA_ADMIN_USER,   pass: process.env.SASA_ADMIN_PASS },
  cashier: { user: process.env.SASA_CASHIER_USER, pass: process.env.SASA_CASHIER_PASS },
  chef:    { user: process.env.SASA_CHEF_USER,    pass: process.env.SASA_CHEF_PASS },
};

// The first screen each role should land on, and a heading that proves it.
const LANDING = {
  admin:   { nav: 'Overview',  heading: 'Today' },
  cashier: { nav: 'New order', heading: null },
  chef:    { nav: 'Kitchen',   heading: 'Kitchen' },
};

async function login(page, role) {
  const u = USERS[role];
  if (!u.user || !u.pass) throw new Error(`Missing credentials for ${role}. See .env.example`);
  await page.goto('/');
  await page.fill('#username', u.user);
  await page.fill('#password', u.pass);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('#app-screen')).toBeVisible();
}

module.exports = { USERS, LANDING, login };
