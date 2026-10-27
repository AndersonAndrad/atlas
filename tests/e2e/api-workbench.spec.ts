import { readFileSync, writeFileSync } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, test, type AtlasHarness } from './fixtures';

// SDD-014 Milestone A: the API Workbench against a real HTTP server on 127.0.0.1 started by
// the test. Nothing needs the internet.

let server: http.Server;
let base = '';
let counter = 0;

test.beforeAll(async () => {
  server = http.createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const url = new URL(request.url ?? '/', 'http://localhost');
    const json = (value: unknown) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if (url.pathname === '/api/users')
      return json({ data: [{ id: 1, name: 'Example User' }], total: 1 });
    if (url.pathname === '/echo') {
      return json({
        method: request.method,
        path: request.url,
        authorization: request.headers.authorization ?? null,
        contentType: request.headers['content-type'] ?? null,
        body: body.toString('utf8'),
        bytes: body.length,
      });
    }
    if (url.pathname === '/counter') return json({ count: ++counter });
    if (url.pathname === '/hang') return; // never answers
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const navigate = (page: Page, name: string) =>
  page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name, exact: true })
    .click();

const workbench = (page: Page) => page.getByTestId('api-workbench');

async function openWorkbench(atlas: AtlasHarness, page: Page) {
  await page.getByTestId('project-card').filter({ hasText: 'backend' }).click();
  await navigate(page, 'API');
  await expect(workbench(page)).toBeVisible();
  void atlas;
}

async function createCollection(page: Page, name: string) {
  await workbench(page).getByRole('button', { name: 'New collection' }).first().click();
  const dialog = page.getByTestId('collection-dialog');
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByRole('button', { name: 'Create collection' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('collection').filter({ hasText: name })).toBeVisible();
}

async function newRequestIn(page: Page, collection: string) {
  await page.getByRole('button', { name: `Actions for collection ${collection}` }).click();
  await page.getByRole('menuitem', { name: 'New request' }).click();
}

const send = (page: Page) =>
  page.getByTestId('request-editor').getByRole('button', { name: 'Send' }).click();

async function saveAs(page: Page, name: string) {
  await workbench(page).getByRole('button', { name: 'Save', exact: true }).click();
  const dialog = page.getByTestId('save-request-dialog');
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
}

async function stubSaveDialog(app: ElectronApplication, file: string) {
  await app.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = (async () => ({
      canceled: false,
      filePath: target,
    })) as unknown as typeof dialog.showSaveDialog;
  }, file);
}

test('creates, sends, saves and restores a request (Scenario A)', async ({ atlas }) => {
  atlas.cli('project', 'add', atlas.workspace('backend'));
  const first = await atlas.launch();
  let page = first.page;
  await openWorkbench(atlas, page);
  await createCollection(page, 'Backend');
  await newRequestIn(page, 'Backend');

  await page.getByLabel('URL').fill(`${base}/api/users`);
  await send(page);
  await expect(page.getByTestId('response-status')).toHaveText('200 OK');
  await expect(page.getByTestId('response-body')).toContainText('"Example User"');
  await expect(page.getByTestId('response-size')).toContainText('B');
  await page.getByRole('tab', { name: 'Timing' }).click();
  await expect(page.getByTestId('response-timing')).toContainText('TLS handshake');
  await expect(page.getByTestId('response-timing')).toContainText('Did not happen');

  await saveAs(page, 'List users');
  const saved = page.getByTestId('collection-request').filter({ hasText: 'List users' });
  await expect(saved).toBeVisible();
  await page.getByRole('tab', { name: 'History' }).click();
  await expect(page.getByTestId('history-entry').first()).toContainText(`${base}/api/users`);
  await expect(page.getByTestId('history-entry').first()).toContainText('200');

  await first.app.close();
  page = (await atlas.launch()).page;
  await openWorkbench(atlas, page);
  await page.getByTestId('collection-request').filter({ hasText: 'List users' }).click();
  await expect(page.getByLabel('URL')).toHaveValue(`${base}/api/users`);
  await send(page);
  await expect(page.getByTestId('response-status')).toHaveText('200 OK');
});

test('keeps secrets out of storage and refuses unresolved variables (FR-1404, FR-1409)', async ({
  atlas,
}) => {
  atlas.cli('project', 'add', atlas.workspace('backend'));
  const first = await atlas.launch();
  let page = first.page;
  await openWorkbench(atlas, page);
  await createCollection(page, 'Auth');
  await newRequestIn(page, 'Auth');

  await page.getByLabel('URL').fill('{{baseUrl}}/echo');
  await expect(page.getByTestId('unresolved-variables')).toContainText('{{baseUrl}}');
  await expect(
    page.getByTestId('request-editor').getByRole('button', { name: 'Send' }),
  ).toBeDisabled();

  await page.getByLabel('URL').fill(`${base}/echo?page=1`);
  await page.getByLabel('Method').fill('POST');
  await page.getByRole('tab', { name: /^Headers/ }).click();
  const headers = page.getByTestId('request-headers');
  await headers.getByRole('button', { name: 'Add header' }).click();
  await headers.getByLabel('header name').fill('Authorization');
  await headers.getByLabel('header value').fill('Bearer s3cr3t');
  await expect(
    headers.getByRole('button', { name: 'Authorization is always secret' }),
  ).toBeDisabled();

  await page.getByRole('tab', { name: 'Body' }).click();
  await page.getByLabel('Body type').click();
  await page.getByRole('option', { name: 'Form URL encoded' }).click();
  const fields = page.getByTestId('form-fields');
  await fields.getByRole('button', { name: 'Add field' }).click();
  await fields.getByLabel('field name').fill('user');
  await fields.getByLabel('field value').fill('ana maria');

  await send(page);
  await expect(page.getByTestId('response-status')).toHaveText('200 OK');
  const body = page.getByTestId('response-body');
  await expect(body).toContainText('"authorization": "Bearer s3cr3t"');
  await expect(body).toContainText('user=ana+maria');
  await expect(body).toContainText('application/x-www-form-urlencoded');
  await page.getByRole('tab', { name: 'Sent' }).click();
  await expect(page.getByTestId('request-sent-headers')).toContainText('[secret]');
  await expect(page.getByTestId('request-sent-headers')).not.toContainText('s3cr3t');

  await saveAs(page, 'Echo');
  await first.app.close();

  page = (await atlas.launch()).page;
  await openWorkbench(atlas, page);
  await page.getByTestId('collection-request').filter({ hasText: 'Echo' }).click();
  await page.getByRole('tab', { name: /^Headers/ }).click();
  const value = page.getByTestId('request-headers').getByLabel('header value');
  await expect(value).toHaveValue('');
  await expect(value).toHaveAttribute('placeholder', 'Secret: enter it each session');
  await send(page);
  await expect(page.getByTestId('response-failed')).toContainText('Secret values are not saved');
  await expect(page.getByTestId('response-failed')).toContainText('Authorization');
});

test('cancels a request without reporting a response (FR-1407)', async ({ atlas }) => {
  atlas.cli('project', 'add', atlas.workspace('backend'));
  const { page } = await atlas.launch();
  await openWorkbench(atlas, page);
  await workbench(page).getByRole('button', { name: 'New request' }).first().click();
  await page.getByLabel('URL').fill(`${base}/hang`);
  await send(page);
  await expect(page.getByTestId('response-sending')).toBeVisible();
  await page.getByTestId('request-editor').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('response-failed')).toContainText('The request was cancelled.');
  await page.getByRole('tab', { name: 'History' }).click();
  await expect(page.getByTestId('history-entry').first()).toContainText('No response');
});

test('uploads a picked file and downloads the response (FR-1405, FR-1411)', async ({ atlas }) => {
  atlas.cli('project', 'add', atlas.workspace('backend'));
  const upload = path.join(atlas.root, 'photo.bin');
  writeFileSync(upload, Buffer.from('12345'));
  const { app, page } = await atlas.launch();
  await openWorkbench(atlas, page);
  await workbench(page).getByRole('button', { name: 'New request' }).first().click();
  await page.getByLabel('Method').fill('PUT');
  await page.getByLabel('URL').fill(`${base}/echo`);
  await page.getByRole('tab', { name: 'Body' }).click();
  await page.getByLabel('Body type').click();
  await page.getByRole('option', { name: 'Binary file' }).click();
  await atlas.stubDirectoryPicker(app, upload);
  await page.getByRole('button', { name: 'Choose file…' }).click();
  await expect(page.getByTestId('binary-file')).toHaveText('photo.bin');
  await send(page);
  await expect(page.getByTestId('response-body')).toContainText('"bytes": 5');
  await expect(page.getByTestId('response-body')).toContainText('application/octet-stream');

  const download = path.join(atlas.root, 'response.json');
  await stubSaveDialog(app, download);
  await page.getByRole('button', { name: 'Download' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  expect(JSON.parse(readFileSync(download, 'utf8'))).toMatchObject({ method: 'PUT', bytes: 5 });
});

test('saves two responses and compares them (FR-1415)', async ({ atlas }) => {
  atlas.cli('project', 'add', atlas.workspace('backend'));
  const { page } = await atlas.launch();
  await openWorkbench(atlas, page);
  await createCollection(page, 'Counter');
  await newRequestIn(page, 'Counter');
  await page.getByLabel('URL').fill(`${base}/counter`);
  await saveAs(page, 'Count');
  for (const name of ['First', 'Second']) {
    await send(page);
    await expect(page.getByTestId('response-status')).toHaveText('200 OK');
    await page.getByRole('button', { name: 'Save response' }).click();
    const dialog = page.getByTestId('snapshot-dialog');
    await expect(dialog).toContainText('may contain personal or sensitive data');
    await dialog.getByLabel('Name').fill(name);
    await dialog.getByRole('button', { name: 'Save response' }).click();
    await expect(dialog).toBeHidden();
  }
  await page.getByRole('button', { name: 'Compare' }).click();
  const snapshots = page.getByTestId('snapshots-dialog');
  await expect(snapshots.getByTestId('snapshot-row')).toHaveCount(2);
  await snapshots.getByRole('checkbox', { name: 'Compare First' }).click();
  await snapshots.getByRole('checkbox', { name: 'Compare Second' }).click();
  await snapshots.getByRole('button', { name: 'Compare' }).click();
  const comparison = snapshots.getByTestId('snapshot-comparison');
  await expect(comparison).toBeVisible();
  await expect(comparison).toContainText('"count"');
});
