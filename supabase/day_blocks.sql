-- Claude-written blocks in a day's notes: "### Meeting prep" (tomorrow_prep.py, 21:00 the night before)
-- and "### Meeting summaries" (meeting and call summaries for the day).
-- Applied to Supabase project "Daybook" (iximbcxwyhnedeojjwsa) on 2026-11-23. Callable only with the service role.
--
-- Rules:
--  * Only data.notes is changed. log, media, conversations and endOfDay are never touched.
--  * The block last written for a day/kind is remembered in public.day_blocks. A rerun replaces exactly that text,
--    so there is never a second copy. If Scott edited inside the block, it is left as he has it.
--  * Blocks always sit at the end of notes, prep first, then summaries. In the app everything below a heading
--    belongs to that section, so anything typed or imported after a block is moved above it, unchanged.
--  * updated_at = stored value + 1 (same rule as daybook_import_page): devices without pending edits pick it up;
--    a device holding a newer unsynced edit keeps it. rev comes from the sync_touch trigger.
--  * If a device push drops a block, the hourly journal import (daybook_import_page) re-adds it once.
--    If it disappears again it is treated as deleted on purpose.

create table if not exists public.day_blocks (
  user_id uuid not null references auth.users(id) on delete cascade,
  date date not null,
  kind text not null check (kind in ('prep','summaries')),
  block text not null,
  written_at timestamptz not null default now(),
  healed_at timestamptz,
  primary key (user_id, date, kind)
);
alter table public.day_blocks enable row level security;
revoke all on public.day_blocks from anon, authenticated;

create or replace function public.daybook_blocks_apply(p_uid uuid, p_date date, p_kind text, p_block text, p_mode text)
returns json language plpgsql security definer set search_path to '' as $$
declare
  v_row public.days%rowtype; v_has boolean; v_notes text; v_rest text; v_tail text := ''; v_new text;
  k text; v_head text; rec public.day_blocks%rowtype; v_target text; v_status jsonb := '{}'::jsonb;
begin
  select * into v_row from public.days where user_id = p_uid and date = p_date for update;
  v_has := found;
  if v_has and v_row.deleted then return json_build_object('date', p_date, 'changed', false, 'skipped', 'day deleted in app'); end if;
  v_notes := public.daybook_trim(case when v_has then coalesce(v_row.data->>'notes', '') else '' end);
  v_rest := v_notes;

  foreach k in array array['prep', 'summaries'] loop
    v_head := case k when 'prep' then 'meeting prep' else 'meeting summaries' end;
    rec := null;
    select * into rec from public.day_blocks where user_id = p_uid and date = p_date and kind = k;
    v_target := case when k = p_kind and p_mode = 'set' then p_block else rec.block end;
    if v_target is null then continue; end if;

    if rec.block is not null and position(E'\n' || rec.block || E'\n' in E'\n' || v_rest || E'\n') > 0 then
      v_rest := replace(E'\n' || v_rest || E'\n', E'\n' || rec.block || E'\n', E'\n');
      v_rest := public.daybook_trim(regexp_replace(v_rest, E'\n[ \t]*\n([ \t]*\n)+', E'\n\n', 'g'));
      v_tail := v_tail || E'\n\n' || v_target;
      v_status := v_status || jsonb_build_object(k, case when v_target = rec.block then 'kept' else 'replaced' end);
    elsif v_rest ~* ('(^|\n)#{1,6}[ \t]+' || v_head || '[ \t]*(\n|$)') then
      v_status := v_status || jsonb_build_object(k, 'edited in app, left as is');
      continue;
    elsif k = p_kind and p_mode = 'set' then
      v_tail := v_tail || E'\n\n' || v_target;
      v_status := v_status || jsonb_build_object(k, 'added');
    elsif p_mode = 'heal' and rec.healed_at is null then
      v_tail := v_tail || E'\n\n' || v_target;
      update public.day_blocks set healed_at = now() where user_id = p_uid and date = p_date and kind = k;
      v_status := v_status || jsonb_build_object(k, 're-added');
    else
      v_status := v_status || jsonb_build_object(k, 'removed in app, not re-added');
      continue;
    end if;
  end loop;

  if p_mode = 'set' and coalesce(v_status->>p_kind, '') <> 'edited in app, left as is' then
    insert into public.day_blocks (user_id, date, kind, block, written_at, healed_at) values (p_uid, p_date, p_kind, p_block, now(), null)
      on conflict (user_id, date, kind) do update set block = excluded.block, written_at = now(), healed_at = null;
  end if;

  v_new := public.daybook_trim(v_rest || v_tail);
  if v_has and v_new = coalesce(v_row.data->>'notes', '') then return json_build_object('date', p_date, 'changed', false, 'blocks', v_status); end if;
  if not v_has and v_new = '' then return json_build_object('date', p_date, 'changed', false); end if;
  if v_has then
    update public.days set data = jsonb_set(coalesce(data, '{}'::jsonb), '{notes}', to_jsonb(v_new)), updated_at = v_row.updated_at + 1
      where user_id = p_uid and date = p_date;
  else
    insert into public.days (user_id, date, data, updated_at, deleted)
      values (p_uid, p_date, jsonb_build_object('log', '[]'::jsonb, 'notes', v_new, 'conversations', '', 'media', '', 'endOfDay', ''), 1, false);
  end if;
  return json_build_object('date', p_date, 'changed', true, 'blocks', v_status);
end $$;

create or replace function public.daybook_set_block(p_email text, p_date date, p_kind text, p_md text)
returns json language plpgsql security definer set search_path to '' as $$
declare v_uid uuid; v_body text;
begin
  if p_kind not in ('prep', 'summaries') then raise exception 'kind must be prep or summaries'; end if;
  select id into v_uid from auth.users where email = lower(public.daybook_trim(p_email));
  if v_uid is null then raise exception 'No Daybook account for that email'; end if;
  -- no em dashes for Scott
  v_body := public.daybook_trim(replace(replace(replace(coalesce(p_md, ''), E'\r', ''), ' — ', ', '), '—', ', '));
  -- headings inside would split the block into several sections in the app
  v_body := regexp_replace(v_body, '^#{1,6}[ \t]+(.+?)[ \t]*$', '**\1**', 'gn');
  if v_body = '' then raise exception 'Empty block'; end if;
  return public.daybook_blocks_apply(v_uid, p_date, p_kind,
    case p_kind when 'prep' then '### Meeting prep' else '### Meeting summaries' end || E'\n' || v_body, 'set');
end $$;

create or replace function public.daybook_set_prep(p_email text, p_date date, p_md text)
returns json language sql security definer set search_path to '' as $$ select public.daybook_set_block(p_email, p_date, 'prep', p_md) $$;
create or replace function public.daybook_set_summaries(p_email text, p_date date, p_md text)
returns json language sql security definer set search_path to '' as $$ select public.daybook_set_block(p_email, p_date, 'summaries', p_md) $$;

-- The hourly journal import: the original function was renamed daybook_import_page_core; this wrapper runs it,
-- then puts back any block a device push dropped (once) and moves blocks back to the end of notes.
create or replace function public.daybook_import_page(p_email text, p_date date, p_md text)
returns json language plpgsql security definer set search_path to '' as $$
declare v_res json; v_uid uuid;
begin
  v_res := public.daybook_import_page_core(p_email, p_date, p_md);
  select id into v_uid from auth.users where email = lower(public.daybook_trim(p_email));
  if exists (select 1 from public.day_blocks where user_id = v_uid and date = p_date) then
    v_res := (v_res::jsonb || jsonb_build_object('blocks', public.daybook_blocks_apply(v_uid, p_date, null, null, 'heal')::jsonb))::json;
  end if;
  return v_res;
end $$;

revoke all on function public.daybook_blocks_apply(uuid, date, text, text, text) from public, anon, authenticated;
revoke all on function public.daybook_set_block(text, date, text, text) from public, anon, authenticated;
revoke all on function public.daybook_set_prep(text, date, text) from public, anon, authenticated;
revoke all on function public.daybook_set_summaries(text, date, text) from public, anon, authenticated;
revoke all on function public.daybook_import_page(text, date, text) from public, anon, authenticated;
