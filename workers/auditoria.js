// Worker 1 - Auditoria (Kardex)
// Grava cada movimentação na tabela movimentacoes_estoque.
// Idempotente: evento_id é UNIQUE no banco, então uma mensagem reenviada não duplica o registro.
const supabase = require('../src/supabase');
const { iniciarWorker } = require('../src/rabbitmq');

iniciarWorker('fila.auditoria', async (evento) => {
  const { error } = await supabase.from('movimentacoes_estoque').insert({
    evento_id: evento.eventoId,
    produto_id: evento.produtoId,
    tipo: evento.tipo,
    quantidade: evento.quantidadeMovimentada,
    saldo_anterior: evento.saldoAnterior,
    saldo_atual: evento.saldoAtual,
    criado_em: evento.timestamp,
  });

  // 23505 = violação de UNIQUE: esse evento já foi gravado antes
  if (error?.code === '23505') {
    console.log(`[auditoria] evento ${evento.eventoId} já registrado, ignorando (idempotência)`);
    return;
  }
  if (error) throw new Error(error.message);

  console.log(
    `[auditoria] ${evento.tipo} de ${evento.quantidadeMovimentada} un. em "${evento.nomeProduto}" ` +
      `(${evento.saldoAnterior} -> ${evento.saldoAtual}) registrada`
  );
}).catch((err) => {
  console.error('[auditoria] falha ao iniciar:', err.message);
  process.exit(1);
});
