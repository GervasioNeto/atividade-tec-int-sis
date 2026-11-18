// Worker 3 - Sincronização de Vitrine
// saldo 0                 -> disponivel = false
// ENTRADA com saldo > 0   -> disponivel = true
const supabase = require('../src/supabase');
const { iniciarWorker } = require('../src/rabbitmq');

iniciarWorker('fila.vitrine', async (evento) => {
  let disponivel = null;
  if (evento.saldoAtual === 0) disponivel = false;
  else if (evento.tipo === 'ENTRADA' && evento.saldoAtual > 0) disponivel = true;

  if (disponivel === null) {
    console.log(`[vitrine] "${evento.nomeProduto}" com saldo ${evento.saldoAtual}, vitrine sem alteração`);
    return;
  }

  const { error } = await supabase.from('produtos').update({ disponivel }).eq('id', evento.produtoId);
  if (error) throw new Error(error.message);

  console.log(`[vitrine] "${evento.nomeProduto}" marcado como ${disponivel ? 'DISPONÍVEL' : 'ESGOTADO'}`);
}).catch((err) => {
  console.error('[vitrine] falha ao iniciar:', err.message);
  process.exit(1);
});
