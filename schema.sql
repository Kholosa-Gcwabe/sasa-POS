-- Sasa POS: database schema, security rules, audit log and realtime.
-- Run this whole file once in the Supabase SQL Editor.

-- ============================================================
-- TABLES
-- ============================================================
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  username    text unique not null,
  full_name   text not null,
  role        text not null check (role in ('admin', 'cashier', 'chef')),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table public.menu_items (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  price       numeric(10,2) not null check (price >= 0),
  category    text not null default 'Other',
  available   boolean not null default true,
  created_at  timestamptz not null default now()
);

create table public.orders (
  id            uuid primary key default gen_random_uuid(),
  order_number  bigint generated always as identity (start with 1001) unique,
  cashier_id    uuid not null references public.profiles(id),
  chef_id       uuid references public.profiles(id),
  completed_by  uuid references public.profiles(id),
  customer_name text,
  notes         text,
  status        text not null default 'pending'
                check (status in ('pending','preparing','ready','completed','cancelled')),
  subtotal      numeric(10,2) not null default 0,
  vat           numeric(10,2) not null default 0,
  total         numeric(10,2) not null default 0,
  created_at    timestamptz not null default now(),
  preparing_at  timestamptz,
  ready_at      timestamptz,
  completed_at  timestamptz,
  cancelled_at  timestamptz
);
create index orders_status_idx on public.orders (status);
create index orders_created_idx on public.orders (created_at desc);

create table public.order_items (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references public.orders(id) on delete cascade,
  menu_item_id  uuid references public.menu_items(id) on delete set null,
  name          text not null,
  price         numeric(10,2) not null,
  quantity      int not null check (quantity between 1 and 50)
);
create index order_items_order_idx on public.order_items (order_id);

create table public.activity_log (
  id          bigint generated always as identity primary key,
  user_id     uuid references public.profiles(id) on delete set null,
  action      text not null,
  details     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index activity_created_idx on public.activity_log (created_at desc);

-- ============================================================
-- HELPERS
-- ============================================================
-- Role of the signed-in user, or null if not an active staff member.
create or replace function public.app_role()
returns text
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid() and active
$$;

create or replace function public.log_activity(p_action text, p_details jsonb default '{}'::jsonb)
returns void
language sql security definer set search_path = public as $$
  insert into public.activity_log (user_id, action, details)
  values (auth.uid(), p_action, p_details)
$$;
revoke all on function public.log_activity(text, jsonb) from public, anon, authenticated;

-- ============================================================
-- CREATE ORDER (prices are looked up server side, never trusted from the browser)
-- ============================================================
create or replace function public.create_order(
  p_items    jsonb,
  p_customer text default null,
  p_notes    text default null
)
returns public.orders
language plpgsql security definer set search_path = public as $$
declare
  v_order    public.orders;
  v_item     jsonb;
  v_menu     public.menu_items;
  v_qty      int;
  v_subtotal numeric(10,2) := 0;
  v_vat      numeric(10,2);
begin
  if app_role() not in ('cashier', 'admin') then
    raise exception 'Only cashiers can create orders';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'The order is empty';
  end if;

  insert into orders (cashier_id, customer_name, notes)
  values (auth.uid(), nullif(trim(p_customer), ''), nullif(trim(p_notes), ''))
  returning * into v_order;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty := (v_item->>'quantity')::int;
    if v_qty is null or v_qty < 1 or v_qty > 50 then
      raise exception 'Invalid quantity';
    end if;
    select * into v_menu from menu_items
      where id = (v_item->>'menu_item_id')::uuid and available;
    if not found then
      raise exception 'An item in this order is no longer available';
    end if;
    insert into order_items (order_id, menu_item_id, name, price, quantity)
    values (v_order.id, v_menu.id, v_menu.name, v_menu.price, v_qty);
    v_subtotal := v_subtotal + v_menu.price * v_qty;
  end loop;

  v_vat := round(v_subtotal * 0.15, 2);
  update orders
     set subtotal = v_subtotal, vat = v_vat, total = v_subtotal + v_vat
   where id = v_order.id
  returning * into v_order;

  return v_order;
end $$;
revoke all on function public.create_order(jsonb, text, text) from public, anon;
grant execute on function public.create_order(jsonb, text, text) to authenticated;

-- ============================================================
-- ORDER STATUS RULES + AUDIT
-- pending -> preparing -> ready (chef) ; ready -> completed (cashier)
-- cancel allowed for cashier/admin until completed ; admin can do all
-- ============================================================
create or replace function public.orders_before_update()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_role text := app_role();
begin
  if new.status is distinct from old.status then
    if v_role is null then
      raise exception 'Not allowed';
    end if;

    if old.status = 'pending' and new.status = 'preparing' and v_role in ('chef','admin') then
      new.chef_id := auth.uid();
      new.preparing_at := now();
    elsif old.status = 'preparing' and new.status = 'ready' and v_role in ('chef','admin') then
      new.chef_id := coalesce(new.chef_id, auth.uid());
      new.ready_at := now();
    elsif old.status = 'ready' and new.status = 'completed' and v_role in ('cashier','admin') then
      new.completed_by := auth.uid();
      new.completed_at := now();
    elsif old.status in ('pending','preparing','ready') and new.status = 'cancelled'
          and v_role in ('cashier','admin') then
      new.cancelled_at := now();
    else
      raise exception 'You cannot move an order from % to %', old.status, new.status;
    end if;
  end if;
  return new;
end $$;

create trigger orders_before_update
  before update on public.orders
  for each row execute function public.orders_before_update();

create or replace function public.orders_after_change()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform log_activity('order_created', jsonb_build_object('order_number', new.order_number));
  elsif new.status is distinct from old.status then
    perform log_activity('order_' || new.status,
      jsonb_build_object('order_number', new.order_number, 'from', old.status));
  end if;
  return null;
end $$;

create trigger orders_after_change
  after insert or update on public.orders
  for each row execute function public.orders_after_change();

-- Audit staff changes and menu changes
create or replace function public.profiles_after_update()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.active is distinct from old.active then
    perform log_activity(case when new.active then 'staff_activated' else 'staff_deactivated' end,
      jsonb_build_object('username', new.username));
  end if;
  if new.role is distinct from old.role then
    perform log_activity('staff_role_changed',
      jsonb_build_object('username', new.username, 'from', old.role, 'to', new.role));
  end if;
  return null;
end $$;

create trigger profiles_after_update
  after update on public.profiles
  for each row execute function public.profiles_after_update();

create or replace function public.menu_after_change()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform log_activity('menu_item_added', jsonb_build_object('name', new.name, 'price', new.price));
  elsif tg_op = 'UPDATE' then
    if new.price is distinct from old.price then
      perform log_activity('menu_price_changed',
        jsonb_build_object('name', new.name, 'from', old.price, 'to', new.price));
    end if;
    if new.available is distinct from old.available then
      perform log_activity('menu_availability_changed',
        jsonb_build_object('name', new.name, 'available', new.available));
    end if;
  else
    perform log_activity('menu_item_deleted', jsonb_build_object('name', old.name));
  end if;
  return null;
end $$;

create trigger menu_after_change
  after insert or update or delete on public.menu_items
  for each row execute function public.menu_after_change();

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
alter table public.profiles     enable row level security;
alter table public.menu_items   enable row level security;
alter table public.orders       enable row level security;
alter table public.order_items  enable row level security;
alter table public.activity_log enable row level security;

-- profiles: staff can see colleagues (for names); only admins edit, never themselves
create policy profiles_select on public.profiles
  for select to authenticated
  using (app_role() is not null or id = auth.uid());
create policy profiles_update on public.profiles
  for update to authenticated
  using (app_role() = 'admin' and id <> auth.uid())
  with check (app_role() = 'admin' and id <> auth.uid());

-- menu: everyone on staff reads, admin manages
create policy menu_select on public.menu_items
  for select to authenticated using (app_role() is not null);
create policy menu_insert on public.menu_items
  for insert to authenticated with check (app_role() = 'admin');
create policy menu_update on public.menu_items
  for update to authenticated using (app_role() = 'admin') with check (app_role() = 'admin');
create policy menu_delete on public.menu_items
  for delete to authenticated using (app_role() = 'admin');

-- orders and items: staff read; changes go through create_order() and status updates only
create policy orders_select on public.orders
  for select to authenticated using (app_role() is not null);
create policy orders_update on public.orders
  for update to authenticated using (app_role() is not null) with check (app_role() is not null);
create policy order_items_select on public.order_items
  for select to authenticated using (app_role() is not null);

-- audit log: admin read only; written by triggers
create policy activity_select on public.activity_log
  for select to authenticated using (app_role() = 'admin');

-- Browsers may only change an order's status column directly.
revoke insert, update, delete on public.orders from authenticated, anon;
grant update (status) on public.orders to authenticated;
revoke insert, update, delete on public.order_items from authenticated, anon;
revoke insert, update, delete on public.activity_log from authenticated, anon;
-- Profiles: browsers may only change active / role (staff are created by the edge function).
revoke insert, delete on public.profiles from authenticated, anon;
revoke update on public.profiles from authenticated, anon;
grant update (active, role, full_name) on public.profiles to authenticated;

-- ============================================================
-- REALTIME (kitchen sees new orders, cashier sees "ready")
-- ============================================================
alter publication supabase_realtime add table public.orders;

-- ============================================================
-- STARTER MENU (edit or delete in the admin screen)
-- ============================================================
insert into public.menu_items (name, price, category) values
  ('Bunny Chow (quarter)', 55, 'Mains'),
  ('Bunny Chow (half)',    85, 'Mains'),
  ('Kota',                 45, 'Mains'),
  ('Gatsby',               89, 'Mains'),
  ('Pap & Wors',           65, 'Mains'),
  ('Chicken & Chips',      70, 'Mains'),
  ('Boerewors Roll',       35, 'Snacks'),
  ('Vetkoek & Mince',      40, 'Snacks'),
  ('Chips',                25, 'Sides'),
  ('Coleslaw',             15, 'Sides'),
  ('Rooibos Tea',          18, 'Drinks'),
  ('Ginger Beer',          22, 'Drinks'),
  ('Cooldrink 330ml',      20, 'Drinks');