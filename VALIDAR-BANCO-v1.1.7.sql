-- LGC WIN v1.1.7 - VALIDACAO DO BANCO
-- SOMENTE LEITURA, exceto a verificacao de existencia das tabelas.
-- Resultado esperado da versao: 1.1.2

select table_name, exists (
  select 1 from information_schema.tables t2
  where t2.table_schema='public' and t2.table_name=t.table_name
) as existe
from (values
  ('app_meta'),
  ('profiles'),
  ('verification_requests'),
  ('raffles'),
  ('coupons'),
  ('purchases'),
  ('raffle_numbers'),
  ('purchase_numbers'),
  ('punishments'),
  ('raffle_results'),
  ('audit_logs'),
  ('guild_settings')
) as t(table_name)
order by table_name;

do $$
declare v_version text;
begin
  if to_regclass('public.app_meta') is null then
    raise exception 'FALHA: public.app_meta nao existe. Execute BANCO-ZERADO-v1.1.7.sql.';
  end if;

  select value into v_version
  from public.app_meta
  where key='schema_version';

  if v_version is distinct from '1.1.2' then
    raise exception 'FALHA: schema_version esperado 1.1.2, encontrado %.', coalesce(v_version,'nenhuma');
  end if;
end $$;

select 'schema_version' as teste, value as resultado
from public.app_meta
where key='schema_version';

select 'compras_ativas_multiplas_por_usuario' as teste, count(*) as observacao
from (
  select discord_id from public.purchases
  where status in ('pending','in_review')
  group by discord_id having count(*) > 1
) x;

select 'numeros_reservados_sem_compra_ativa' as teste, count(*) as problemas
from public.raffle_numbers rn
left join public.purchases p on p.id=rn.purchase_id
where rn.status='reserved'
  and (p.id is null or p.status not in ('pending','in_review'));

select 'numeros_vendidos_sem_compra_aprovada' as teste, count(*) as problemas
from public.raffle_numbers rn
left join public.purchases p on p.id=rn.purchase_id
where rn.status='sold'
  and (p.id is null or p.status<>'approved');

select 'compras_aprovadas_sem_numeros_vendidos' as teste, count(*) as problemas
from public.purchases p
where p.status='approved'
  and not exists (
    select 1 from public.raffle_numbers rn
    where rn.purchase_id=p.id and rn.status='sold'
  );

select 'rifas_sorteadas_sem_resultado' as teste, count(*) as problemas
from public.raffles r
where r.status='drawn'
  and not exists (select 1 from public.raffle_results rr where rr.raffle_id=r.id);

select 'resultados_com_rifa_nao_sorteada' as teste, count(*) as problemas
from public.raffle_results rr
join public.raffles r on r.id=rr.raffle_id
where r.status<>'drawn';

select 'cupons_acima_limite_total' as teste, count(*) as problemas
from public.coupons c
where (
  select count(*) from public.purchases p
  where p.coupon_id=c.id and p.status in ('pending','in_review','approved')
) > c.max_uses;

select 'reservas_pendentes_vencidas' as teste, count(*) as observacao_worker
from public.purchases
where status='pending' and expires_at<=now();

select 'analises_vencidas' as teste, count(*) as observacao_worker
from public.purchases
where status='in_review' and review_expires_at<=now();

select 'coluna_name_coupons' as teste, count(*) as resultado
from information_schema.columns
where table_schema='public' and table_name='coupons' and column_name='name';

select 'coluna_unverified_role_id' as teste, count(*) as resultado
from information_schema.columns
where table_schema='public' and table_name='guild_settings' and column_name='unverified_role_id';
