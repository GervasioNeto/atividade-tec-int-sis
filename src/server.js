require('dotenv').config();
const express = require('express');
const { randomUUID } = require('crypto');
const supabase = require('./supabase');
const { iniciarPublicador, publicarEvento } = require('./rabbitmq');

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------
// CRUD de produtos
// ---------------------------------------------------------------------
app.get('/produtos', async (req, res) => {
  const { data, error } = await supabase.from('produtos').select('*').order('id');
  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);
});

app.get('/produtos/:id', async (req, res) => {
  const { data, error } = await supabase.from('produtos').select('*').eq('id', req.params.id).maybeSingle();
  if (error) return res.status(500).json({ erro: error.message });
  if (!data) return res.status(404).json({ erro: 'Produto não encontrado' });
  res.json(data);
});

app.post('/produtos', async (req, res) => {
  const { nome, preco = 0, estoque = 0, estoque_minimo = 5 } = req.body ?? {};
  if (!nome) return res.status(400).json({ erro: 'Campo "nome" é obrigatório' });

  const { data, error } = await supabase
    .from('produtos')
    .insert({ nome, preco, estoque, estoque_minimo, disponivel: estoque > 0 })
    .select()
    .single();
  if (error) return res.status(400).json({ erro: error.message });
  res.status(201).json(data);
});

// O estoque NÃO é alterado aqui: só pela rota /movimentar, para tudo passar pela auditoria.
app.put('/produtos/:id', async (req, res) => {
  const { nome, preco, estoque_minimo } = req.body ?? {};
  const { data, error } = await supabase
    .from('produtos')
    .update({ nome, preco, estoque_minimo })
    .eq('id', req.params.id)
    .select()
    .maybeSingle();
  if (error) return res.status(400).json({ erro: error.message });
  if (!data) return res.status(404).json({ erro: 'Produto não encontrado' });
  res.json(data);
});

app.delete('/produtos/:id', async (req, res) => {
  const { data, error } = await supabase.from('produtos').delete().eq('id', req.params.id).select().maybeSingle();
  if (error?.code === '23503') {
    return res.status(409).json({ erro: 'Produto possui histórico de movimentações e não pode ser excluído' });
  }
  if (error) return res.status(400).json({ erro: error.message });
  if (!data) return res.status(404).json({ erro: 'Produto não encontrado' });
  res.status(204).end();
});

// ---------------------------------------------------------------------
// Movimentação de estoque (PRODUTOR de eventos)
// Body: { "tipo": "ENTRADA" | "SAIDA", "quantidade": 2 }
// ---------------------------------------------------------------------
app.post('/produtos/:id/movimentar', async (req, res) => {
  const id = Number(req.params.id);
  const tipo = String(req.body?.tipo || '').toUpperCase();
  const quantidade = Number(req.body?.quantidade);

  if (!['ENTRADA', 'SAIDA'].includes(tipo)) {
    return res.status(400).json({ erro: 'Campo "tipo" deve ser ENTRADA ou SAIDA' });
  }
  if (!Number.isInteger(quantidade) || quantidade <= 0) {
    return res.status(400).json({ erro: 'Campo "quantidade" deve ser um inteiro maior que zero' });
  }

  // 1) Produto existe?
  const { data: produto, error } = await supabase
    .from('produtos')
    .select('id, nome, estoque, estoque_minimo')
    .eq('id', id)
    .maybeSingle();
  if (error) return res.status(500).json({ erro: error.message });
  if (!produto) return res.status(404).json({ erro: 'Produto não encontrado' });

  // 2) Tem saldo suficiente?
  const saldoAnterior = produto.estoque;
  const saldoAtual = tipo === 'ENTRADA' ? saldoAnterior + quantidade : saldoAnterior - quantidade;
  if (saldoAtual < 0) {
    return res.status(422).json({ erro: 'Saldo insuficiente', saldoDisponivel: saldoAnterior });
  }

  // 3) Atualiza o saldo. O filtro .eq('estoque', saldoAnterior) evita que duas
  //    vendas simultâneas sobrescrevam uma à outra (lock otimista).
  const { data: atualizado, error: erroUpdate } = await supabase
    .from('produtos')
    .update({ estoque: saldoAtual })
    .eq('id', id)
    .eq('estoque', saldoAnterior)
    .select('id');
  if (erroUpdate) return res.status(500).json({ erro: erroUpdate.message });
  if (atualizado.length === 0) {
    return res.status(409).json({ erro: 'O estoque foi alterado por outra requisição. Tente novamente.' });
  }

  // 4) Publica o evento na exchange (sem aguardar os consumidores)
  const evento = {
    eventoId: randomUUID(),
    produtoId: produto.id,
    nomeProduto: produto.nome,
    tipo,
    quantidadeMovimentada: quantidade,
    saldoAnterior,
    saldoAtual,
    estoqueMinimo: produto.estoque_minimo,
    timestamp: new Date().toISOString(),
  };
  publicarEvento(evento);

  // 5) Responde na hora
  res.status(200).json({ mensagem: 'Movimentação registrada', evento });
});

// Erros inesperados
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ erro: 'Erro interno' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`API rodando em http://localhost:${PORT}`);
  iniciarPublicador();
});
