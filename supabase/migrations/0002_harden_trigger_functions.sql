-- Close the three security-advisor findings from 0001.

-- Pin search_path on set_updated_at (linter 0011_function_search_path_mutable).
create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- These are trigger functions, never meant to be called over the REST RPC surface.
-- Triggers fire as the table owner regardless of EXECUTE grants, so revoking EXECUTE
-- closes the RPC hole (linters 0028/0029) without affecting the triggers.
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.set_updated_at() from public, anon, authenticated;
