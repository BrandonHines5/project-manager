-- Pin search_path on touch_updated_at
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  new.updated_at := now();
  return new;
end;
$fn$;

-- Helpers should not be RPC-callable.
revoke execute on function public.current_role_name() from anon, authenticated, public;
revoke execute on function public.is_staff() from anon, authenticated, public;
revoke execute on function public.is_member_of_project(uuid) from anon, authenticated, public;
revoke execute on function public.handle_new_user() from anon, authenticated, public;
revoke execute on function public.touch_updated_at() from anon, authenticated, public;
