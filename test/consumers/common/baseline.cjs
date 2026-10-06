require('reflect-metadata');
const { MemoryStorage } = require('@nestarc/idempotency');

new MemoryStorage();
console.log('PASS baseline root MemoryStorage import');
