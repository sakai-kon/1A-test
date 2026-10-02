-- 1A 合唱練習サイト / Supabase schema
-- Supabase SQL Editorで実行してください。

create table if not exists public.settings (
  key text primary key,
  value text not null
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  type text not null check (type in ('text', 'voice')),
  author text not null default '匿名',
  title text not null default '',
  body text not null default '',
  object_path text,
  mime_type text,
  size_bytes bigint,
  duration_ms integer,
  created_at timestamptz not null default now()
);

create index if not exists messages_created_at_idx
  on public.messages (created_at desc);

alter table public.settings enable row level security;
alter table public.messages enable row level security;

drop policy if exists "authenticated can read settings" on public.settings;
create policy "authenticated can read settings"
  on public.settings for select to authenticated using (true);

drop policy if exists "authenticated can write settings" on public.settings;
create policy "authenticated can write settings"
  on public.settings for all to authenticated using (true) with check (true);

drop policy if exists "authenticated can read messages" on public.messages;
create policy "authenticated can read messages"
  on public.messages for select to authenticated using (true);

drop policy if exists "authenticated can insert messages" on public.messages;
create policy "authenticated can insert messages"
  on public.messages for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "authenticated can delete messages" on public.messages;
create policy "authenticated can delete messages"
  on public.messages for delete to authenticated using (true);

grant select, insert, update, delete on public.settings to authenticated;
grant select, insert, delete on public.messages to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('choir-audio', 'choir-audio', false, 10485760, array['audio/*'])
on conflict (id) do update
set public = false,
    file_size_limit = 10485760,
    allowed_mime_types = array['audio/*'];

drop policy if exists "authenticated can upload choir audio" on storage.objects;
create policy "authenticated can upload choir audio"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'choir-audio');

drop policy if exists "authenticated can read choir audio" on storage.objects;
create policy "authenticated can read choir audio"
  on storage.objects for select to authenticated
  using (bucket_id = 'choir-audio');

drop policy if exists "authenticated can delete choir audio" on storage.objects;
create policy "authenticated can delete choir audio"
  on storage.objects for delete to authenticated
  using (bucket_id = 'choir-audio');

insert into public.settings(key, value)
values ('siteTitle', '1A 合唱練習サイト')
on conflict (key) do nothing;

insert into public.settings(key, value)
values ('songTitle', '')
on conflict (key) do nothing;
