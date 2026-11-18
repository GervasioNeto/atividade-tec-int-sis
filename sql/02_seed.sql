-- Dados de exemplo (opcional). Executar uma vez, depois do 01_schema.sql.
insert into produtos (nome, preco, estoque, estoque_minimo) values
  ('Teclado Mecânico RGB', 349.90, 6, 5),
  ('Mouse Gamer',          159.90, 3, 2),
  ('Monitor 27"',         1899.00, 10, 3);

-- Consultas úteis durante a apresentação:
-- select * from produtos order by id;
-- select * from movimentacoes_estoque order by criado_em desc;
-- select * from alertas_reposicao order by criado_em desc;
