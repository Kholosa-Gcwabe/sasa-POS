const { test, expect } = require('@playwright/test');
const { USERS, LANDING, login } = require('./helpers');

test.describe('Login and roles', () => {
  // TC-001 to TC-003
  for (const role of ['admin', 'cashier', 'chef']) {
    test(`${role} can sign in and lands on the right screen`, async ({ page }) => {
      await login(page, role);
      await expect(page.locator('#who .role-pill')).toHaveText(role);
      await expect(page.locator('.nav-btn.active')).toContainText(LANDING[role].nav);
      if (LANDING[role].heading) {
        await expect(page.locator('h2.title')).toHaveText(LANDING[role].heading);
      }
    });
  }

  // TC-004
  test('wrong password is rejected with a clear message', async ({ page }) => {
    await page.goto('/');
    await page.fill('#username', USERS.cashier.user || 'nobody');
    await page.fill('#password', 'definitely-wrong-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator('.toast-error')).toContainText('Wrong username or password');
    await expect(page.locator('#app-screen')).toBeHidden();
  });

  // TC-005
  test('empty form cannot be submitted', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator('#app-screen')).toBeHidden();
    await expect(page.locator('#login-screen')).toBeVisible();
  });

  // TC-006
  test('username is not case sensitive', async ({ page }) => {
    await page.goto('/');
    await page.fill('#username', (USERS.cashier.user || '').toUpperCase());
    await page.fill('#password', USERS.cashier.pass || '');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator('#app-screen')).toBeVisible();
  });

  // TC-007
  test('log out returns to the login screen', async ({ page }) => {
    await login(page, 'cashier');
    await page.locator('#logout').click();
    await expect(page.locator('#login-screen')).toBeVisible();
    await expect(page.locator('#app-screen')).toBeHidden();
  });

  // TC-008
  test('QR tab shows the scanner panel and hides the password form', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Scan QR card' }).click();
    await expect(page.locator('#scan-panel')).toBeVisible();
    await expect(page.locator('#login-form')).toBeHidden();
  });
});

test.describe('Role restrictions (UI)', () => {
  // TC-009
  test('cashier does not see admin screens', async ({ page }) => {
    await login(page, 'cashier');
    const nav = page.locator('#nav');
    await expect(nav).toContainText('New order');
    await expect(nav).toContainText('My orders');
    for (const hidden of ['Staff', 'Reports', 'Settings', 'Activity', 'Menu', 'Kitchen']) {
      await expect(nav).not.toContainText(hidden);
    }
  });

  // TC-010
  test('chef only sees the kitchen', async ({ page }) => {
    await login(page, 'chef');
    await expect(page.locator('#nav .nav-btn')).toHaveCount(1);
    await expect(page.locator('#nav')).toContainText('Kitchen');
  });

  // TC-011
  test('admin sees all management screens', async ({ page }) => {
    await login(page, 'admin');
    for (const label of ['Overview', 'Orders', 'Reports', 'Staff', 'Menu', 'Settings', 'Activity']) {
      await expect(page.locator('#nav')).toContainText(label);
    }
  });
});
