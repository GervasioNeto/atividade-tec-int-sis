-- =====================================================================
-- Executar no Supabase: SQL Editor > New query > colar > Run
-- O script pode ser rodado mais de uma vez sem erro.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Tabela produtos (já existia; só é criada se ainda não existir)
-- ---------------------------------------------------------------------
create table if not exists produtos (
  id        bigint generated always as identity primary key,
  nome      text not null,
  preco     numeric(10, 2) not null default 0,
  estoque   integer not null default 0 check (estoque >= 0),
  criado_em timestamptz not null default now()
);

-- Ajuste pedido na atividade: novas colunas em produtos
alter table produtos add column if not exists estoque_minimo integer not null default 5;
alter table produtos add column if not exists disponivel     boolean not null default true;

-- ---------------------------------------------------------------------
-- 2) Auditoria (Kardex) - preenchida pelo worker de auditoria
-- ---------------------------------------------------------------------
create table if not exists movimentacoes_estoque (
  id             bigint generated always as identity primary key,
  evento_id      uuid not null unique, -- garante a idempotência
  produto_id     bigint not null references produtos (id),
  tipo           text not null check (tipo in ('ENTRADA', 'SAIDA')),
  quantidade     integer not null check (quantidade > 0),
  saldo_anterior integer not null,
  saldo_atual    integer not null,
  criado_em      timestamptz not null default now()
);

-- Histórico imutável: bloqueia UPDATE e DELETE no Kardex
create or replace function bloquear_alteracao_kardex()
returns trigger as $$
begin
  raise exception 'movimentacoes_estoque é imutável: não é permitido UPDATE nem DELETE';
end;
$$ language plpgsql;

drop trigger if exists trg_kardex_imutavel on movimentacoes_estoque;
create trigger trg_kardex_imutavel
  before update or delete on movimentacoes_estoque
  for each row execute function bloquear_alteracao_kardex();

-- ---------------------------------------------------------------------
-- 3) Alertas de reposição (Compras) - preenchida pelo worker de compras
-- ---------------------------------------------------------------------
create table if not exists alertas_reposicao (
  id             bigint generated always as identity primary key,
  evento_id      uuid unique, -- extra: evita alerta duplicado se a mensagem for reenviada
  produto_id     bigint not null references produtos (id),
  saldo_atual    integer not null,
  estoque_minimo integer not null,
  status         text not null default 'PENDENTE' check (status in ('PENDENTE', 'RESOLVIDO')),
  criado_em      timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 4) Permissões para a chave service_role (usada pelo backend)
-- ---------------------------------------------------------------------
grant select, insert, update, delete on produtos, movimentacoes_estoque, alertas_reposicao to service_role;
grant usage, select on all sequences in schema public to service_role;
