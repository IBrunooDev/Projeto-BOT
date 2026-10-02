import { syncSlashCommands } from './command-sync.js';

try {
  await syncSlashCommands();
  console.log('🚀 Comandos do LGC Win sincronizados.');
} catch (error) {
  console.error('❌ Não foi possível sincronizar os comandos.');
  console.error('O bot não é afetado por este erro.');
  process.exitCode = 1;
}
