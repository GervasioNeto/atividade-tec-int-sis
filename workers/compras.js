// Worker 2 - Alerta de Compras
// Se saldoAtual <= estoqueMinimo, grava um alerta em alertas_reposicao e "notifica" o setor de compras.
const supabase = require('../src/supabase');
const { iniciarWorker } = require('../src/rabbitmq');

iniciarWorker('fila.compras', async (evento) => {
  if (evento.saldoAtual > evento.estoqueMinimo) {
    console.log(`[compras] "${evento.nomeProduto}" com saldo ${evento.saldoAtual} (mínimo ${evento.estoqueMinimo}), sem alerta`);
    return;
  }

  const { error } = await supabase.from('alertas_reposicao').insert({
    evento_id: evento.eventoId,
    produto_id: evento.produtoId,
    saldo_atual: evento.saldoAtual,
    estoque_minimo: evento.estoqueMinimo,
    status: 'PENDENTE',
  });

  if (error?.code === '23505') {
    console.log(`[compras] alerta do evento ${evento.eventoId} já registrado, ignorando (idempotência)`);
    return;
  }
  if (error) throw new Error(error.message);

  // Simulação do disparo da notificação (log estruturado)
  console.log(
    JSON.stringify({
      nivel: 'ALERTA',
      tipo: 'ESTOQUE_CRITICO',
      destinatario: 'compras@empresa.com',
      canal: 'email',
      produtoId: evento.produtoId,
      nomeProduto: evento.nomeProduto,
      saldoAtual: evento.saldoAtual,
      estoqueMinimo: evento.estoqueMinimo,
      eventoId: evento.eventoId,
      enviadoEm: new Date().toISOString(),
    })
  );
}).catch((err) => {
  console.error('[compras] falha ao iniciar:', err.message);
  process.exit(1);
});
