# Estoque orientado a eventos (Express + Supabase + RabbitMQ)

A rota de movimentação de estoque atualiza o saldo no Supabase, publica um evento no RabbitMQ e responde na hora.
Três workers independentes consomem o evento: **auditoria**, **compras** e **vitrine**.
Se um worker estiver lento ou fora do ar, a API continua respondendo e as mensagens esperam na fila.

```
                                           ┌──> fila.auditoria ──> worker:auditoria ──> movimentacoes_estoque
POST /produtos/:id/movimentar              │
   API Express ──publish──> estoque.eventos├──> fila.compras ────> worker:compras ────> alertas_reposicao
   (atualiza produtos)      (exchange      │
                             fanout)       └──> fila.vitrine ────> worker:vitrine ────> produtos.disponivel
```

## Estrutura

```
docker-compose.yml     RabbitMQ com painel de gerenciamento (porta 15672)
.env.example           variáveis de ambiente
sql/01_schema.sql      DDL executado no Supabase (ALTER TABLE e CREATE TABLE)
sql/02_seed.sql        produtos de exemplo
src/server.js          API Express (CRUD + movimentação = produtor)
src/rabbitmq.js        conexão, exchange, filas, publicação e consumo
src/supabase.js        cliente do Supabase
workers/auditoria.js   Worker 1: Kardex, idempotente pelo eventoId
workers/compras.js     Worker 2: alerta de estoque crítico
workers/vitrine.js     Worker 3: disponível / esgotado
requests.http          requisições de teste
```

## Como rodar

1. **Banco:** no Supabase, abra o *SQL Editor* e execute `sql/01_schema.sql` e depois `sql/02_seed.sql`.
2. **Variáveis:** copie `.env.example` para `.env` e preencha `SUPABASE_URL` e `SUPABASE_KEY` (use a chave **service_role**).
3. **RabbitMQ:**
   ```bash
   docker compose up -d
   ```
   Painel em http://localhost:15672 (usuário `admin`, senha `admin`).
4. **Dependências:**
   ```bash
   npm install
   ```
5. **API e workers**, cada um em um terminal:
   ```bash
   npm start
   npm run worker:auditoria
   npm run worker:compras
   npm run worker:vitrine
   ```

## Endpoints

| Método | Rota | Body |
|---|---|---|
| GET | `/produtos` | |
| GET | `/produtos/:id` | |
| POST | `/produtos` | `{ "nome", "preco", "estoque", "estoque_minimo" }` |
| PUT | `/produtos/:id` | `{ "nome", "preco", "estoque_minimo" }` |
| DELETE | `/produtos/:id` | |
| POST | `/produtos/:id/movimentar` | `{ "tipo": "ENTRADA" ou "SAIDA", "quantidade": 2 }` |

O saldo só muda pela rota `/movimentar`, para toda alteração passar pela auditoria.

Respostas da rota `/movimentar`: `200` com o evento publicado, `400` com dados inválidos, `404` se o produto não existe, `422` se o saldo é insuficiente e `409` se outra venda alterou o saldo ao mesmo tempo.

Exemplo de evento publicado:

```json
{
  "eventoId": "2f1c7a0e-8a4b-4b8e-9d0e-3c5f6a7b8c9d",
  "produtoId": 1,
  "nomeProduto": "Teclado Mecânico RGB",
  "tipo": "SAIDA",
  "quantidadeMovimentada": 2,
  "saldoAnterior": 6,
  "saldoAtual": 4,
  "estoqueMinimo": 5,
  "timestamp": "2026-11-16T22:00:00.000Z"
}
```

## Resiliência

- Exchange `estoque.eventos` (fanout) e filas `fila.auditoria`, `fila.compras` e `fila.vitrine` são **duráveis**. As mensagens são publicadas com `persistent: true`.
- A API também declara as filas ao subir. Assim a fila de um worker existe mesmo que ele nunca tenha sido ligado, e nenhuma mensagem se perde.
- Os workers usam `noAck: false` e só chamam `channel.ack(msg)` depois que o Supabase confirma a operação. Se o Supabase falhar, a mensagem volta para a fila (`nack` com requeue) e é tentada de novo em 5s.
- `prefetch(1)`: cada worker processa uma mensagem por vez.
- **Idempotência:** `evento_id` é `UNIQUE` em `movimentacoes_estoque`. Se a mesma mensagem chegar duas vezes, o insert dá erro de duplicidade (`23505`) e o worker só confirma a mensagem, sem duplicar o registro. O mesmo foi feito em `alertas_reposicao`.
- O Kardex é imutável: um trigger no banco bloqueia `UPDATE` e `DELETE` em `movimentacoes_estoque`.

## Roteiro da prova de resiliência

Com o seed, o *Teclado Mecânico RGB* (id 1) começa com estoque 6 e mínimo 5.

1. Suba tudo (RabbitMQ, API e os 3 workers).
2. **Derrube o worker de compras** com `CTRL+C` no terminal dele.
3. Faça **2 vendas** de 1 unidade (saldo 6 → 5 → 4, as duas ficam no mínimo ou abaixo):
   ```bash
   curl -X POST http://localhost:3000/produtos/1/movimentar -H "Content-Type: application/json" -d "{\"tipo\":\"SAIDA\",\"quantidade\":1}"
   curl -X POST http://localhost:3000/produtos/1/movimentar -H "Content-Type: application/json" -d "{\"tipo\":\"SAIDA\",\"quantidade\":1}"
   ```
   No PowerShell use `curl.exe` em vez de `curl`, ou as requisições do `requests.http`.
4. Mostre que a API respondeu **200** normalmente.
5. No painel (http://localhost:15672 → *Queues and Streams*), mostre `fila.compras` com **2 mensagens em Ready**, enquanto as outras filas estão zeradas.
6. **Religue o worker:** `npm run worker:compras`. Ele processa as 2 mensagens e mostra os logs de alerta.
7. No Supabase, mostre os 2 registros:
   ```sql
   select * from alertas_reposicao order by criado_em desc;
   ```
   No painel, `fila.compras` volta para 0.

Para repetir a demonstração, faça uma `ENTRADA` que traga o saldo de volta para 6.
