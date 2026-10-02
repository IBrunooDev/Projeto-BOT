-- =============================================================
-- LGC WIN v1.1.7 - BANCO ZERADO / INSTALACAO LIMPA (schema 1.1.2)
-- =============================================================
-- ATENCAO: este arquivo APAGA somente as tabelas/funcoes do LGC Win
-- e recria o sistema vazio. Use em projeto novo ou quando quiser zerar.
-- Ele NAO apaga usuarios do Supabase Auth nem tabelas de outros apps.
-- =============================================================

begin;

-- Remove funcoes conhecidas de versoes anteriores.
drop function if exists public.manage_raffle(uuid,text,text,text) cascade;
drop function if exists public.finalize_draw(uuid,integer,text) cascade;
drop function if exists public.finalize_random_draw(uuid,text) cascade;
drop function if exists public.create_raffle_with_numbers(text,text,text,text,integer,bigint,integer,integer,integer,text) cascade;
drop function if exists public.request_verification(text,text,integer) cascade;
drop function if exists public.approve_verification(uuid,text) cascade;
drop function if exists public.reject_verification(uuid,text,text) cascade;
drop function if exists public.reserve_numbers(uuid,text,integer[],text,text) cascade;
drop function if exists public.claim_purchase(uuid,text,integer) cascade;
drop function if exists public.force_claim_purchase(uuid,text,integer) cascade;
drop function if exists public.release_purchase_review(uuid,text,boolean) cascade;
drop function if exists public.approve_purchase(uuid,text) cascade;
drop function if exists public.reject_purchase(uuid,text,text) cascade;
drop function if exists public.expire_pending_reservations() cascade;
drop function if exists public.release_stale_reviews() cascade;
drop function if exists public.cancel_pending_purchase_system(uuid,text) cascade;
drop function if exists public.apply_abandonment_penalty(text,uuid) cascade;

-- Remove SOMENTE as tabelas do LGC Win.
drop table if exists public.guild_settings cascade;
drop table if exists public.raffle_results cascade;
drop table if exists public.purchase_numbers cascade;
drop table if exists public.raffle_numbers cascade;
drop table if exists public.purchases cascade;
drop table if exists public.coupons cascade;
drop table if exists public.punishments cascade;
drop table if exists public.verification_requests cascade;
drop table if exists public.profiles cascade;
drop table if exists public.raffles cascade;
drop table if exists public.audit_logs cascade;
drop table if exists public.app_meta cascade;

create extension if not exists pgcrypto;

create table public.app_meta (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key default gen_random_uuid(),
  discord_id text not null unique,
  mta_name text,
  mta_id integer unique,
  verified boolean not null default false,
  verified_by text,
  verified_at timestamptz,
  abandoned_reservations integer not null default 0 check (abandoned_reservations >= 0),
  blocked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.verification_requests (
  id uuid primary key default gen_random_uuid(),
  discord_id text not null,
  mta_name text not null check (char_length(trim(mta_name)) between 2 and 40),
  mta_id integer not null check (mta_id > 0),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  reviewed_by text,
  reviewed_at timestamptz,
  rejection_reason text,
  review_channel_id text,
  review_message_id text,
  created_at timestamptz not null default now()
);
create unique index verification_pending_discord_uq on public.verification_requests(discord_id) where status='pending';
create unique index verification_pending_mta_uq on public.verification_requests(mta_id) where status='pending';

create table public.raffles (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null,
  name text not null check (char_length(trim(name)) between 1 and 100),
  description text not null check (char_length(description) between 1 and 1000),
  image_url text,
  number_count integer not null check (number_count between 1 and 10000),
  number_price bigint not null check (number_price > 0),
  max_numbers_per_reservation integer not null default 10 check (max_numbers_per_reservation between 1 and 1000),
  max_numbers_per_user integer check (max_numbers_per_user is null or max_numbers_per_user between 1 and 10000),
  reservation_minutes integer not null default 10 check (reservation_minutes between 1 and 120),
  status text not null default 'active' check (status in ('active','paused','closed','drawn','cancelled')),
  panel_channel_id text,
  panel_message_id text,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.coupons (
  id uuid primary key default gen_random_uuid(),
  raffle_id uuid references public.raffles(id) on delete restrict,
  name text not null,
  code text not null check (char_length(trim(code)) between 2 and 30),
  discount_percent numeric(5,2) not null check (discount_percent > 0 and discount_percent <= 100),
  min_numbers integer not null default 1 check (min_numbers > 0),
  max_uses integer not null check (max_uses > 0),
  max_uses_per_user integer not null default 1 check (max_uses_per_user > 0),
  expires_at timestamptz,
  active boolean not null default true,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index coupons_code_active_uq on public.coupons(upper(code)) where deleted_at is null;

create table public.purchases (
  id uuid primary key default gen_random_uuid(),
  raffle_id uuid not null references public.raffles(id) on delete restrict,
  discord_id text not null,
  game_phone varchar(6) not null check (game_phone ~ '^[0-9]{1,6}$'),
  status text not null default 'pending' check (status in ('pending','in_review','approved','rejected','expired')),
  coupon_id uuid references public.coupons(id) on delete set null,
  coupon_code_snapshot text,
  discount_percent_snapshot numeric(5,2) not null default 0 check (discount_percent_snapshot between 0 and 100),
  subtotal bigint not null check (subtotal >= 0),
  discount_amount bigint not null default 0 check (discount_amount >= 0),
  total bigint not null check (total >= 0),
  expires_at timestamptz not null,
  claimed_by text,
  claimed_at timestamptz,
  review_expires_at timestamptz,
  approved_by text,
  approved_at timestamptz,
  rejected_by text,
  rejected_at timestamptz,
  rejection_reason text,
  review_channel_id text,
  review_message_id text,
  created_at timestamptz not null default now()
);
-- O controle de uma compra ativa por usuario fica na funcao reserve_numbers.
-- Isso permite que o Dono, quando autorizado pelo bot, tenha varias compras ativas.
create index purchases_user_status_idx on public.purchases(discord_id,status);
create index purchases_raffle_status_idx on public.purchases(raffle_id,status);
create index purchases_expires_idx on public.purchases(status,expires_at);
create index purchases_review_expires_idx on public.purchases(status,review_expires_at);
create index purchases_coupon_status_idx on public.purchases(coupon_id,status) where coupon_id is not null;

create table public.raffle_numbers (
  id uuid primary key default gen_random_uuid(),
  raffle_id uuid not null references public.raffles(id) on delete cascade,
  number integer not null check (number > 0),
  status text not null default 'available' check (status in ('available','reserved','sold')),
  reserved_by text,
  reserved_until timestamptz,
  purchase_id uuid references public.purchases(id) on delete set null,
  sold_to text,
  sold_at timestamptz,
  unique (raffle_id,number)
);
create index raffle_numbers_raffle_status_idx on public.raffle_numbers(raffle_id,status);
create index raffle_numbers_purchase_idx on public.raffle_numbers(purchase_id) where purchase_id is not null;

create table public.purchase_numbers (
  id uuid primary key default gen_random_uuid(),
  purchase_id uuid not null references public.purchases(id) on delete cascade,
  raffle_number_id uuid not null references public.raffle_numbers(id) on delete restrict,
  number integer not null,
  created_at timestamptz not null default now(),
  unique (purchase_id,number)
);
create index purchase_numbers_purchase_idx on public.purchase_numbers(purchase_id);

create table public.punishments (
  id uuid primary key default gen_random_uuid(),
  discord_id text not null,
  punishment_type text not null check (punishment_type in ('warning','temporary','permanent')),
  reason text not null,
  blocked_until timestamptz,
  created_by text not null,
  created_at timestamptz not null default now(),
  removed_by text,
  removed_at timestamptz,
  removal_reason text
);
create index punishments_user_created_idx on public.punishments(discord_id,created_at desc);

create table public.raffle_results (
  id uuid primary key default gen_random_uuid(),
  raffle_id uuid not null unique references public.raffles(id) on delete restrict,
  winning_number integer not null,
  winner_discord_id text not null,
  winner_mta_id integer,
  winner_game_phone varchar(6),
  drawn_by text not null,
  drawn_at timestamptz not null default now()
);

create table public.audit_logs (
  id bigserial primary key,
  action text not null,
  actor_discord_id text,
  target_discord_id text,
  entity_type text,
  entity_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_logs_created_idx on public.audit_logs(created_at desc);
create index audit_logs_entity_idx on public.audit_logs(entity_type,entity_id);

create table public.guild_settings (
  guild_id text primary key,
  raffle_channel_id text,
  verification_channel_id text,
  verification_log_channel_id text,
  purchase_log_channel_id text,
  results_channel_id text,
  audit_channel_id text,
  owner_role_id text,
  admin_role_id text,
  unverified_role_id text,
  verified_role_id text,
  default_reservation_minutes integer not null default 10 check (default_reservation_minutes between 1 and 120),
  default_review_minutes integer not null default 15 check (default_review_minutes between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- RLS: nenhuma tabela fica exposta a anon/authenticated.
alter table public.app_meta enable row level security;
alter table public.profiles enable row level security;
alter table public.verification_requests enable row level security;
alter table public.raffles enable row level security;
alter table public.coupons enable row level security;
alter table public.purchases enable row level security;
alter table public.raffle_numbers enable row level security;
alter table public.purchase_numbers enable row level security;
alter table public.punishments enable row level security;
alter table public.raffle_results enable row level security;
alter table public.audit_logs enable row level security;
alter table public.guild_settings enable row level security;

-- =============================================================
-- FUNCOES ATOMICAS
-- =============================================================

create or replace function public.create_raffle_with_numbers(
  p_guild_id text,
  p_name text,
  p_description text,
  p_image_url text,
  p_number_count integer,
  p_number_price bigint,
  p_max_per_reservation integer,
  p_max_per_user integer,
  p_reservation_minutes integer,
  p_created_by text
) returns public.raffles
language plpgsql
security definer
set search_path = public
as $$
declare r public.raffles;
begin
  if p_max_per_reservation > p_number_count then
    raise exception 'Maximo por reserva nao pode ser maior que a quantidade de numeros da rifa.';
  end if;
  if p_max_per_user is not null and p_max_per_user > p_number_count then
    raise exception 'Maximo por usuario nao pode ser maior que a quantidade de numeros da rifa.';
  end if;

  insert into public.raffles(
    guild_id,name,description,image_url,number_count,number_price,
    max_numbers_per_reservation,max_numbers_per_user,reservation_minutes,created_by
  ) values(
    p_guild_id,trim(p_name),p_description,nullif(trim(p_image_url),''),p_number_count,p_number_price,
    p_max_per_reservation,p_max_per_user,p_reservation_minutes,p_created_by
  ) returning * into r;

  insert into public.raffle_numbers(raffle_id,number)
  select r.id,gs from generate_series(1,p_number_count) gs;

  insert into public.audit_logs(action,actor_discord_id,entity_type,entity_id,metadata)
  values('RIFA_CRIADA',p_created_by,'raffle',r.id::text,jsonb_build_object('name',r.name,'numbers',r.number_count));
  return r;
end;
$$;

create or replace function public.request_verification(p_discord_id text,p_mta_name text,p_mta_id integer)
returns public.verification_requests
language plpgsql
security definer
set search_path = public
as $$
declare req public.verification_requests;
begin
  if exists(select 1 from public.profiles where discord_id=p_discord_id and verified) then
    raise exception 'Voce ja esta verificado.';
  end if;
  if exists(select 1 from public.profiles where mta_id=p_mta_id and discord_id<>p_discord_id) then
    raise exception 'Este ID do jogo ja esta vinculado a outra conta.';
  end if;
  if exists(select 1 from public.verification_requests where discord_id=p_discord_id and status='pending') then
    raise exception 'Voce ja possui uma verificacao pendente.';
  end if;
  if exists(select 1 from public.verification_requests where mta_id=p_mta_id and status='pending') then
    raise exception 'Este ID ja possui uma verificacao pendente.';
  end if;

  insert into public.verification_requests(discord_id,mta_name,mta_id)
  values(p_discord_id,trim(p_mta_name),p_mta_id)
  returning * into req;
  return req;
end;
$$;

create or replace function public.approve_verification(p_request_id uuid,p_admin_id text)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare req public.verification_requests; prof public.profiles;
begin
  select * into req from public.verification_requests where id=p_request_id for update;
  if not found then raise exception 'Solicitacao nao encontrada.'; end if;
  if req.status<>'pending' then raise exception 'Solicitacao ja finalizada.'; end if;
  if exists(select 1 from public.profiles where mta_id=req.mta_id and discord_id<>req.discord_id) then
    raise exception 'Este ID do jogo ja foi usado por outra conta.';
  end if;

  insert into public.profiles(discord_id,mta_name,mta_id,verified,verified_by,verified_at)
  values(req.discord_id,req.mta_name,req.mta_id,true,p_admin_id,now())
  on conflict(discord_id) do update set
    mta_name=excluded.mta_name,
    mta_id=excluded.mta_id,
    verified=true,
    verified_by=p_admin_id,
    verified_at=now(),
    updated_at=now()
  returning * into prof;

  update public.verification_requests
    set status='approved',reviewed_by=p_admin_id,reviewed_at=now()
    where id=req.id;

  insert into public.audit_logs(action,actor_discord_id,target_discord_id,entity_type,entity_id,metadata)
  values('VERIFICACAO_APROVADA',p_admin_id,req.discord_id,'verification',req.id::text,
    jsonb_build_object('mta_name',req.mta_name,'mta_id',req.mta_id));
  return prof;
end;
$$;

create or replace function public.reject_verification(p_request_id uuid,p_admin_id text,p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare req public.verification_requests;
begin
  select * into req from public.verification_requests where id=p_request_id for update;
  if not found or req.status<>'pending' then raise exception 'Solicitacao nao encontrada ou ja finalizada.'; end if;

  update public.verification_requests
    set status='rejected',reviewed_by=p_admin_id,reviewed_at=now(),rejection_reason=trim(p_reason)
    where id=p_request_id;

  insert into public.audit_logs(action,actor_discord_id,target_discord_id,entity_type,entity_id,metadata)
  values('VERIFICACAO_RECUSADA',p_admin_id,req.discord_id,'verification',req.id::text,
    jsonb_build_object('reason',trim(p_reason),'mta_id',req.mta_id));
end;
$$;

-- Helper interno para punicao progressiva por abandono.
create or replace function public.apply_abandonment_penalty(p_discord_id text,p_purchase_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare new_count integer; new_until timestamptz;
begin
  update public.profiles
    set abandoned_reservations=abandoned_reservations+1,updated_at=now()
    where discord_id=p_discord_id
    returning abandoned_reservations into new_count;

  if new_count is null then return; end if;

  if new_count=2 then
    insert into public.punishments(discord_id,punishment_type,reason,created_by)
    values(p_discord_id,'warning','2 reservas abandonadas','SYSTEM');
  elsif new_count=3 then
    new_until:=now()+interval '30 minutes';
    update public.profiles set blocked_until=greatest(coalesce(blocked_until,now()),new_until) where discord_id=p_discord_id;
    insert into public.punishments(discord_id,punishment_type,reason,blocked_until,created_by)
    values(p_discord_id,'temporary','3 reservas abandonadas - bloqueio de 30 minutos',new_until,'SYSTEM');
  elsif new_count>=5 then
    new_until:=now()+interval '24 hours';
    update public.profiles set blocked_until=greatest(coalesce(blocked_until,now()),new_until) where discord_id=p_discord_id;
    insert into public.punishments(discord_id,punishment_type,reason,blocked_until,created_by)
    values(p_discord_id,'temporary',new_count||' reservas abandonadas - bloqueio de 24 horas',new_until,'SYSTEM');
  end if;

  insert into public.audit_logs(action,target_discord_id,entity_type,entity_id,metadata)
  values('ABANDONO_REGISTRADO',p_discord_id,'purchase',p_purchase_id::text,jsonb_build_object('total_abandonos',new_count));
end;
$$;

create or replace function public.reserve_numbers(
  p_raffle_id uuid,
  p_discord_id text,
  p_numbers integer[],
  p_game_phone text,
  p_coupon_code text default null,
  p_bypass_active_purchase boolean default false
) returns public.purchases
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.raffles;
  prof public.profiles;
  p public.purchases;
  c public.coupons;
  qty integer;
  distinct_qty integer;
  available_qty integer;
  already_bought integer;
  active_coupon_uses integer;
  user_coupon_uses integer;
  subtotal_v bigint;
  discount_v bigint:=0;
  total_v bigint;
  expires_v timestamptz;
  coupon_id_v uuid:=null;
  coupon_code_v text:=null;
  coupon_discount_v numeric(5,2):=0;
  stale record;
begin
  -- Serializa compras do mesmo usuario.
  select * into prof from public.profiles where discord_id=p_discord_id for update;
  if not found or not prof.verified then raise exception 'Voce precisa estar verificado.'; end if;
  if prof.blocked_until is not null and prof.blocked_until>now() then
    raise exception 'Voce esta bloqueado das rifas ate %.',prof.blocked_until;
  end if;

  -- Serializa alteracoes da rifa e impede disputa com sorteio/encerramento.
  select * into r from public.raffles where id=p_raffle_id and deleted_at is null for update;
  if not found or r.status<>'active' then raise exception 'Esta rifa nao esta disponivel.'; end if;
  if p_game_phone !~ '^[0-9]{1,6}$' then raise exception 'Telefone deve conter de 1 a 6 digitos.'; end if;

  -- Se a propria reserva pendente deste usuario ja venceu, limpa aqui mesmo.
  -- Assim ele nao precisa esperar o worker de 30 segundos para tentar de novo.
  for stale in
    select id,discord_id,claimed_at from public.purchases
    where discord_id=p_discord_id and status='pending' and expires_at<=now()
    for update
  loop
    update public.purchases set status='expired' where id=stale.id and status='pending';
    update public.raffle_numbers
      set status='available',reserved_by=null,reserved_until=null,purchase_id=null
      where purchase_id=stale.id and status='reserved';
    if stale.claimed_at is null then perform public.apply_abandonment_penalty(stale.discord_id,stale.id); end if;
    insert into public.audit_logs(action,target_discord_id,entity_type,entity_id,metadata)
    values('RESERVA_EXPIRADA',stale.discord_id,'purchase',stale.id::text,jsonb_build_object('counted_as_abandonment',stale.claimed_at is null,'source','reserve_numbers'));
  end loop;

  qty:=coalesce(array_length(p_numbers,1),0);
  select count(distinct x) into distinct_qty from unnest(p_numbers) x;
  if qty<1 then raise exception 'Escolha pelo menos um numero.'; end if;
  if qty<>distinct_qty then raise exception 'Nao repita numeros na mesma compra.'; end if;
  if qty>r.max_numbers_per_reservation then raise exception 'Limite maximo por reserva: % numeros.',r.max_numbers_per_reservation; end if;

  -- Membros comuns so podem ter uma reserva ativa por vez.
  -- O Dono pode ter varias compras ativas; o bot envia p_bypass_active_purchase=true
  -- somente quando o membro possui o cargo OWNER_ROLE_ID.
  if not p_bypass_active_purchase and exists(
    select 1 from public.purchases
    where discord_id=p_discord_id and status in ('pending','in_review')
  ) then
    raise exception 'Voce ja possui uma reserva ativa.';
  end if;

  if exists(select 1 from unnest(p_numbers) n where n<1 or n>r.number_count) then
    raise exception 'Ha numeros fora do intervalo desta rifa.';
  end if;

  -- Trava os numeros pedidos antes de validar disponibilidade.
  perform 1 from public.raffle_numbers
    where raffle_id=p_raffle_id and number=any(p_numbers)
    order by number
    for update;
  select count(*) into available_qty from public.raffle_numbers
    where raffle_id=p_raffle_id and number=any(p_numbers) and status='available';
  if available_qty<>qty then raise exception 'Um ou mais numeros ja foram reservados ou vendidos.'; end if;

  if r.max_numbers_per_user is not null then
    select count(*) into already_bought from public.raffle_numbers
      where raffle_id=p_raffle_id and status='sold' and sold_to=p_discord_id;
    if already_bought+qty>r.max_numbers_per_user then
      raise exception 'Voce ultrapassaria o limite total de % numeros nesta rifa.',r.max_numbers_per_user;
    end if;
  end if;

  subtotal_v:=r.number_price*qty;

  if nullif(trim(coalesce(p_coupon_code,'')),'') is not null then
    -- O lock da linha do cupom serializa o ultimo uso concorrente.
    select * into c from public.coupons
      where upper(code)=upper(trim(p_coupon_code)) and active=true and deleted_at is null
        and (raffle_id is null or raffle_id=p_raffle_id)
      for update;
    if not found then raise exception 'Cupom invalido ou inativo.'; end if;
    if c.expires_at is not null and c.expires_at<=now() then raise exception 'Cupom expirado.'; end if;
    if qty<c.min_numbers then raise exception 'Este cupom exige no minimo % numeros.',c.min_numbers; end if;

    select count(*) into active_coupon_uses from public.purchases
      where coupon_id=c.id and status in ('pending','in_review','approved');
    if active_coupon_uses>=c.max_uses then raise exception 'Cupom atingiu o limite total de usos.'; end if;

    select count(*) into user_coupon_uses from public.purchases
      where coupon_id=c.id and discord_id=p_discord_id and status in ('pending','in_review','approved');
    if user_coupon_uses>=c.max_uses_per_user then raise exception 'Voce ja atingiu o limite de uso deste cupom.'; end if;

    discount_v:=round(subtotal_v*(c.discount_percent/100.0));
    coupon_id_v:=c.id;
    coupon_code_v:=c.code;
    coupon_discount_v:=c.discount_percent;
  end if;

  total_v:=greatest(subtotal_v-discount_v,0);
  expires_v:=now()+make_interval(mins=>r.reservation_minutes);

  insert into public.purchases(
    raffle_id,discord_id,game_phone,status,coupon_id,coupon_code_snapshot,
    discount_percent_snapshot,subtotal,discount_amount,total,expires_at
  ) values(
    p_raffle_id,p_discord_id,p_game_phone,'pending',coupon_id_v,coupon_code_v,
    coupon_discount_v,subtotal_v,discount_v,total_v,expires_v
  ) returning * into p;

  update public.raffle_numbers
    set status='reserved',reserved_by=p_discord_id,reserved_until=expires_v,purchase_id=p.id
    where raffle_id=p_raffle_id and number=any(p_numbers) and status='available';
  if not found then raise exception 'Falha ao reservar os numeros. Tente novamente.'; end if;

  insert into public.purchase_numbers(purchase_id,raffle_number_id,number)
  select p.id,id,number from public.raffle_numbers where purchase_id=p.id;

  if (select count(*) from public.purchase_numbers where purchase_id=p.id)<>qty then
    raise exception 'Falha de integridade ao registrar os numeros.';
  end if;

  insert into public.audit_logs(action,target_discord_id,entity_type,entity_id,metadata)
  values('RESERVA_CRIADA',p_discord_id,'purchase',p.id::text,
    jsonb_build_object('raffle_id',p_raffle_id,'numbers',p_numbers,'total',total_v,'coupon',coupon_code_v));
  return p;
end;
$$;

create or replace function public.claim_purchase(p_purchase_id uuid,p_admin_id text,p_review_minutes integer default 15)
returns public.purchases
language plpgsql
security definer
set search_path = public
as $$
declare p public.purchases;
begin
  if p_review_minutes<1 or p_review_minutes>120 then raise exception 'Tempo de analise invalido.'; end if;
  select * into p from public.purchases where id=p_purchase_id for update;
  if not found then raise exception 'Compra nao encontrada.'; end if;

  if p.status='in_review' then
    if p.claimed_by=p_admin_id and (p.review_expires_at is null or p.review_expires_at>now()) then return p; end if;
    if p.review_expires_at is not null and p.review_expires_at<=now() then
      update public.purchases set claimed_by=p_admin_id,claimed_at=now(),review_expires_at=now()+make_interval(mins=>p_review_minutes)
        where id=p_purchase_id returning * into p;
      update public.raffle_numbers set reserved_until=p.review_expires_at where purchase_id=p_purchase_id and status='reserved';
      insert into public.audit_logs(action,actor_discord_id,target_discord_id,entity_type,entity_id)
      values('ANALISE_REASSUMIDA_APOS_EXPIRAR',p_admin_id,p.discord_id,'purchase',p.id::text);
      return p;
    end if;
    raise exception 'Esta compra ja foi assumida por outro administrador.';
  end if;

  if p.status<>'pending' then raise exception 'Esta compra nao esta aguardando analise.'; end if;
  if p.expires_at<=now() then raise exception 'Esta reserva ja expirou. Aguarde a liberacao automatica.'; end if;

  update public.purchases
    set status='in_review',claimed_by=p_admin_id,claimed_at=now(),review_expires_at=now()+make_interval(mins=>p_review_minutes)
    where id=p_purchase_id returning * into p;
  update public.raffle_numbers set reserved_until=p.review_expires_at where purchase_id=p_purchase_id and status='reserved';
  insert into public.audit_logs(action,actor_discord_id,target_discord_id,entity_type,entity_id)
  values('ANALISE_ASSUMIDA',p_admin_id,p.discord_id,'purchase',p.id::text);
  return p;
end;
$$;

create or replace function public.force_claim_purchase(p_purchase_id uuid,p_owner_id text,p_review_minutes integer default 15)
returns public.purchases
language plpgsql
security definer
set search_path = public
as $$
declare p public.purchases;
begin
  if p_review_minutes<1 or p_review_minutes>120 then raise exception 'Tempo de analise invalido.'; end if;
  select * into p from public.purchases where id=p_purchase_id for update;
  if not found then raise exception 'Compra nao encontrada.'; end if;
  if p.status not in ('pending','in_review') then raise exception 'Esta compra nao pode mais ser assumida.'; end if;
  if p.status='pending' and p.expires_at<=now() then raise exception 'Esta reserva ja expirou.'; end if;

  update public.purchases
    set status='in_review',claimed_by=p_owner_id,claimed_at=now(),review_expires_at=now()+make_interval(mins=>p_review_minutes)
    where id=p_purchase_id returning * into p;
  update public.raffle_numbers set reserved_until=p.review_expires_at where purchase_id=p_purchase_id and status='reserved';
  insert into public.audit_logs(action,actor_discord_id,target_discord_id,entity_type,entity_id)
  values('ANALISE_ASSUMIDA_FORCADA',p_owner_id,p.discord_id,'purchase',p.id::text);
  return p;
end;
$$;

create or replace function public.release_purchase_review(p_purchase_id uuid,p_admin_id text,p_force boolean default false)
returns public.purchases
language plpgsql
security definer
set search_path = public
as $$
declare p public.purchases; mins integer;
begin
  select * into p from public.purchases where id=p_purchase_id for update;
  if not found then raise exception 'Compra nao encontrada.'; end if;
  if p.status<>'in_review' then raise exception 'Compra nao esta em analise.'; end if;
  if p.claimed_by<>p_admin_id and not p_force then raise exception 'Somente quem assumiu pode liberar a analise.'; end if;
  select reservation_minutes into mins from public.raffles where id=p.raffle_id;

  update public.purchases
    set status='pending',claimed_by=null,review_expires_at=null,expires_at=now()+make_interval(mins=>mins)
    where id=p_purchase_id returning * into p;
  update public.raffle_numbers set reserved_until=p.expires_at where purchase_id=p_purchase_id and status='reserved';
  insert into public.audit_logs(action,actor_discord_id,target_discord_id,entity_type,entity_id)
  values('ANALISE_LIBERADA',p_admin_id,p.discord_id,'purchase',p.id::text);
  return p;
end;
$$;

create or replace function public.approve_purchase(p_purchase_id uuid,p_admin_id text)
returns public.purchases
language plpgsql
security definer
set search_path = public
as $$
declare p public.purchases; r public.raffles; reserved_count integer; expected_count integer;
begin
  select * into p from public.purchases where id=p_purchase_id for update;
  if not found then raise exception 'Compra nao encontrada.'; end if;
  if p.status<>'in_review' then raise exception 'A compra precisa estar em analise.'; end if;
  if p.claimed_by<>p_admin_id then raise exception 'Somente o ADM que assumiu pode aprovar.'; end if;
  if p.review_expires_at is not null and p.review_expires_at<=now() then
    raise exception 'O tempo desta analise expirou. Assuma a compra novamente.';
  end if;

  select * into r from public.raffles where id=p.raffle_id for update;
  if not found or r.status<>'active' then raise exception 'A rifa nao esta mais ativa.'; end if;

  select count(*) into expected_count from public.purchase_numbers where purchase_id=p_purchase_id;
  perform 1 from public.raffle_numbers where purchase_id=p_purchase_id and status='reserved' order by number for update;
  select count(*) into reserved_count from public.raffle_numbers where purchase_id=p_purchase_id and status='reserved';
  if expected_count<1 or reserved_count<>expected_count then raise exception 'Os numeros desta compra nao estao mais integros.'; end if;

  update public.purchases
    set status='approved',approved_by=p_admin_id,approved_at=now(),review_expires_at=null
    where id=p_purchase_id returning * into p;
  update public.raffle_numbers
    set status='sold',sold_to=p.discord_id,sold_at=now(),reserved_by=null,reserved_until=null
    where purchase_id=p_purchase_id and status='reserved';

  insert into public.audit_logs(action,actor_discord_id,target_discord_id,entity_type,entity_id,metadata)
  values('COMPRA_APROVADA',p_admin_id,p.discord_id,'purchase',p.id::text,
    jsonb_build_object('total',p.total,'coupon',p.coupon_code_snapshot));
  return p;
end;
$$;

create or replace function public.reject_purchase(p_purchase_id uuid,p_admin_id text,p_reason text)
returns public.purchases
language plpgsql
security definer
set search_path = public
as $$
declare p public.purchases;
begin
  select * into p from public.purchases where id=p_purchase_id for update;
  if not found then raise exception 'Compra nao encontrada.'; end if;
  if p.status<>'in_review' then raise exception 'A compra precisa estar em analise.'; end if;
  if p.claimed_by<>p_admin_id then raise exception 'Somente o ADM que assumiu pode recusar.'; end if;
  if p.review_expires_at is not null and p.review_expires_at<=now() then
    raise exception 'O tempo desta analise expirou. Assuma a compra novamente.';
  end if;

  update public.purchases
    set status='rejected',rejected_by=p_admin_id,rejected_at=now(),rejection_reason=trim(p_reason),review_expires_at=null
    where id=p_purchase_id returning * into p;
  update public.raffle_numbers
    set status='available',reserved_by=null,reserved_until=null,purchase_id=null
    where purchase_id=p_purchase_id and status='reserved';

  insert into public.audit_logs(action,actor_discord_id,target_discord_id,entity_type,entity_id,metadata)
  values('COMPRA_RECUSADA',p_admin_id,p.discord_id,'purchase',p.id::text,jsonb_build_object('reason',trim(p_reason)));
  return p;
end;
$$;

create or replace function public.cancel_pending_purchase_system(p_purchase_id uuid,p_reason text)
returns public.purchases
language plpgsql
security definer
set search_path = public
as $$
declare p public.purchases;
begin
  select * into p from public.purchases where id=p_purchase_id for update;
  if not found then raise exception 'Compra nao encontrada.'; end if;
  if p.status not in ('pending','in_review') then return p; end if;

  update public.purchases
    set status='expired',review_expires_at=null,rejection_reason=left(trim(p_reason),500)
    where id=p_purchase_id returning * into p;
  update public.raffle_numbers
    set status='available',reserved_by=null,reserved_until=null,purchase_id=null
    where purchase_id=p_purchase_id and status='reserved';

  insert into public.audit_logs(action,actor_discord_id,target_discord_id,entity_type,entity_id,metadata)
  values('COMPRA_CANCELADA_PELO_SISTEMA','SYSTEM',p.discord_id,'purchase',p.id::text,
    jsonb_build_object('reason',left(trim(p_reason),500)));
  return p;
end;
$$;

create or replace function public.expire_pending_reservations()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare rec record; total_expired integer:=0;
begin
  for rec in
    select id,discord_id,claimed_at from public.purchases
    where status='pending' and expires_at<=now()
    order by expires_at,id
    for update skip locked
  loop
    update public.purchases set status='expired' where id=rec.id and status='pending';
    if not found then continue; end if;

    update public.raffle_numbers
      set status='available',reserved_by=null,reserved_until=null,purchase_id=null
      where purchase_id=rec.id and status='reserved';

    if rec.claimed_at is null then
      perform public.apply_abandonment_penalty(rec.discord_id,rec.id);
    end if;

    insert into public.audit_logs(action,target_discord_id,entity_type,entity_id,metadata)
    values('RESERVA_EXPIRADA',rec.discord_id,'purchase',rec.id::text,
      jsonb_build_object('counted_as_abandonment',rec.claimed_at is null));
    total_expired:=total_expired+1;
  end loop;
  return total_expired;
end;
$$;

create or replace function public.release_stale_reviews()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare rec record; total_released integer:=0; mins integer;
begin
  for rec in
    select id,raffle_id,discord_id,claimed_by from public.purchases
    where status='in_review' and review_expires_at is not null and review_expires_at<=now()
    order by review_expires_at,id
    for update skip locked
  loop
    select reservation_minutes into mins from public.raffles where id=rec.raffle_id;
    if mins is null then mins:=10; end if;

    update public.purchases
      set status='pending',claimed_by=null,review_expires_at=null,expires_at=now()+make_interval(mins=>mins)
      where id=rec.id and status='in_review';
    if not found then continue; end if;

    update public.raffle_numbers
      set reserved_until=now()+make_interval(mins=>mins)
      where purchase_id=rec.id and status='reserved';

    insert into public.audit_logs(action,actor_discord_id,target_discord_id,entity_type,entity_id,metadata)
    values('ANALISE_EXPIRADA_LIBERADA','SYSTEM',rec.discord_id,'purchase',rec.id::text,
      jsonb_build_object('previous_admin',rec.claimed_by,'new_reservation_minutes',mins));
    total_released:=total_released+1;
  end loop;
  return total_released;
end;
$$;

create or replace function public.manage_raffle(p_raffle_id uuid,p_action text,p_actor_id text,p_reason text default null)
returns public.raffles
language plpgsql
security definer
set search_path = public
as $$
declare r public.raffles;
begin
  select * into r from public.raffles where id=p_raffle_id for update;
  if not found then raise exception 'Rifa nao encontrada.'; end if;

  if p_action='pause' then
    if r.status<>'active' then raise exception 'Somente uma rifa ativa pode ser pausada.'; end if;
    update public.raffles set status='paused',updated_at=now() where id=p_raffle_id returning * into r;

  elsif p_action='reactivate' then
    if r.status not in ('paused','closed') then raise exception 'Somente rifa pausada ou encerrada pode ser reativada.'; end if;
    if r.deleted_at is not null then raise exception 'Rifa excluida/cancelada nao pode ser reativada.'; end if;
    update public.raffles set status='active',updated_at=now() where id=p_raffle_id returning * into r;

  elsif p_action='close' then
    if r.status not in ('active','paused') then raise exception 'Esta rifa nao pode ser encerrada nesse status.'; end if;
    if exists(select 1 from public.purchases where raffle_id=p_raffle_id and status in ('pending','in_review')) then
      raise exception 'Existem compras pendentes. Aprove, recuse ou aguarde expirar antes de encerrar.';
    end if;
    update public.raffles set status='closed',updated_at=now() where id=p_raffle_id returning * into r;

  elsif p_action='delete' then
    if r.status='drawn' or exists(select 1 from public.raffle_results where raffle_id=p_raffle_id) then
      raise exception 'Rifa ja sorteada nao pode ser excluida.';
    end if;

    update public.purchases set status='expired',review_expires_at=null
      where raffle_id=p_raffle_id and status in ('pending','in_review');
    update public.raffle_numbers
      set status='available',reserved_by=null,reserved_until=null,purchase_id=null
      where raffle_id=p_raffle_id and status='reserved';
    update public.raffles set status='cancelled',deleted_at=now(),updated_at=now() where id=p_raffle_id returning * into r;
  else
    raise exception 'Acao invalida.';
  end if;

  insert into public.audit_logs(action,actor_discord_id,entity_type,entity_id,metadata)
  values('RIFA_GERENCIADA',p_actor_id,'raffle',r.id::text,
    jsonb_build_object('action',p_action,'reason',coalesce(p_reason,''),'status',r.status));
  return r;
end;
$$;

-- Sorteio atomico: trava a rifa, confirma que nao ha pendencias e escolhe
-- o vencedor dentro da MESMA transacao. Assim uma aprovacao concorrente
-- nao fica fora do conjunto do sorteio.
create or replace function public.finalize_random_draw(p_raffle_id uuid,p_drawn_by text)
returns public.raffle_results
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.raffles;
  rn public.raffle_numbers;
  prof public.profiles;
  p public.purchases;
  result public.raffle_results;
begin
  select * into r from public.raffles where id=p_raffle_id for update;
  if not found then raise exception 'Rifa nao encontrada.'; end if;
  if r.status not in ('active','closed') then raise exception 'Rifa precisa estar ativa ou com vendas encerradas para sortear.'; end if;
  if exists(select 1 from public.purchases where raffle_id=p_raffle_id and status in ('pending','in_review')) then
    raise exception 'Existem compras/reservas pendentes. Finalize ou aguarde expirar antes do sorteio.';
  end if;
  if exists(select 1 from public.raffle_results where raffle_id=p_raffle_id) then raise exception 'Esta rifa ja foi sorteada.'; end if;

  select * into rn from public.raffle_numbers
    where raffle_id=p_raffle_id and status='sold'
    order by gen_random_uuid()
    limit 1
    for update;
  if not found then raise exception 'Nenhum numero vendido/aprovado para sortear.'; end if;

  select * into prof from public.profiles where discord_id=rn.sold_to;
  if rn.purchase_id is not null then select * into p from public.purchases where id=rn.purchase_id; end if;

  insert into public.raffle_results(
    raffle_id,winning_number,winner_discord_id,winner_mta_id,winner_game_phone,drawn_by
  ) values(
    p_raffle_id,rn.number,rn.sold_to,prof.mta_id,p.game_phone,p_drawn_by
  ) returning * into result;

  update public.raffles set status='drawn',updated_at=now() where id=p_raffle_id;
  insert into public.audit_logs(action,actor_discord_id,target_discord_id,entity_type,entity_id,metadata)
  values('RIFA_SORTEADA',p_drawn_by,rn.sold_to,'raffle',p_raffle_id::text,
    jsonb_build_object('winning_number',rn.number,'game_phone',p.game_phone));
  return result;
end;
$$;

-- =============================================================
-- PRIVILEGIOS
-- =============================================================

revoke all on table public.app_meta,public.profiles,public.verification_requests,public.raffles,public.coupons,
  public.purchases,public.raffle_numbers,public.purchase_numbers,public.punishments,public.raffle_results,
  public.audit_logs,public.guild_settings from anon,authenticated;
grant all on table public.app_meta,public.profiles,public.verification_requests,public.raffles,public.coupons,
  public.purchases,public.raffle_numbers,public.purchase_numbers,public.punishments,public.raffle_results,
  public.audit_logs,public.guild_settings to service_role;
grant usage,select on sequence public.audit_logs_id_seq to service_role;

revoke all on function public.create_raffle_with_numbers(text,text,text,text,integer,bigint,integer,integer,integer,text) from public,anon,authenticated;
revoke all on function public.request_verification(text,text,integer) from public,anon,authenticated;
revoke all on function public.approve_verification(uuid,text) from public,anon,authenticated;
revoke all on function public.reject_verification(uuid,text,text) from public,anon,authenticated;
revoke all on function public.apply_abandonment_penalty(text,uuid) from public,anon,authenticated;
revoke all on function public.reserve_numbers(uuid,text,integer[],text,text,boolean) from public,anon,authenticated;
revoke all on function public.claim_purchase(uuid,text,integer) from public,anon,authenticated;
revoke all on function public.force_claim_purchase(uuid,text,integer) from public,anon,authenticated;
revoke all on function public.release_purchase_review(uuid,text,boolean) from public,anon,authenticated;
revoke all on function public.approve_purchase(uuid,text) from public,anon,authenticated;
revoke all on function public.reject_purchase(uuid,text,text) from public,anon,authenticated;
revoke all on function public.expire_pending_reservations() from public,anon,authenticated;
revoke all on function public.release_stale_reviews() from public,anon,authenticated;
revoke all on function public.cancel_pending_purchase_system(uuid,text) from public,anon,authenticated;
revoke all on function public.manage_raffle(uuid,text,text,text) from public,anon,authenticated;
revoke all on function public.finalize_random_draw(uuid,text) from public,anon,authenticated;

grant execute on function public.create_raffle_with_numbers(text,text,text,text,integer,bigint,integer,integer,integer,text) to service_role;
grant execute on function public.request_verification(text,text,integer) to service_role;
grant execute on function public.approve_verification(uuid,text) to service_role;
grant execute on function public.reject_verification(uuid,text,text) to service_role;
grant execute on function public.reserve_numbers(uuid,text,integer[],text,text,boolean) to service_role;
grant execute on function public.claim_purchase(uuid,text,integer) to service_role;
grant execute on function public.force_claim_purchase(uuid,text,integer) to service_role;
grant execute on function public.release_purchase_review(uuid,text,boolean) to service_role;
grant execute on function public.approve_purchase(uuid,text) to service_role;
grant execute on function public.reject_purchase(uuid,text,text) to service_role;
grant execute on function public.expire_pending_reservations() to service_role;
grant execute on function public.release_stale_reviews() to service_role;
grant execute on function public.cancel_pending_purchase_system(uuid,text) to service_role;
grant execute on function public.manage_raffle(uuid,text,text,text) to service_role;
grant execute on function public.finalize_random_draw(uuid,text) to service_role;

-- Registra a versão do schema dentro da instalação.
insert into public.app_meta(key,value) values('schema_version','1.1.2')
on conflict(key) do update set value=excluded.value,updated_at=now();

commit;

-- Conferência FINAL fora da transação principal.
-- Se o script chegou até aqui, a instalação foi concluída e o bot
-- poderá confirmar a versão 1.1.2 no startup.
insert into public.app_meta(key,value) values('schema_version','1.1.2')
on conflict(key) do update set value=excluded.value,updated_at=now();

select key, value, updated_at
from public.app_meta
where key='schema_version';
