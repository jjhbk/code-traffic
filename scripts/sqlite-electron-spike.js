const { app } = require('electron');

async function main() {
  await app.whenReady();
  try {
    const { DatabaseSync } = require('node:sqlite');
    const database = new DatabaseSync(':memory:');
    database.exec('CREATE TABLE probe (value TEXT); INSERT INTO probe VALUES (\'ok\');');
    const value = database.prepare('SELECT value FROM probe').get().value;
    database.close();
    if (value !== 'ok') throw new Error('SQLite probe returned an unexpected value.');
    process.stdout.write('Electron SQLite probe passed\n');
    app.exit(0);
  } catch (error) {
    process.stderr.write(`Electron SQLite probe failed: ${error.stack || error.message}\n`);
    app.exit(1);
  }
}

main().catch((error) => {
  process.stderr.write(`Electron SQLite probe failed: ${error.stack || error.message}\n`);
  app.exit(1);
});
