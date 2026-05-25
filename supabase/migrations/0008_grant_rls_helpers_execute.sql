-- RLS helpers must be EXECUTEable by the roles that hit the policies.
-- Without this every policy using is_staff() / is_member_of_project() fails
-- with "permission denied for function" and the row check silently rejects.
grant execute on function public.is_staff()             to anon, authenticated;
grant execute on function public.current_role_name()    to anon, authenticated;
grant execute on function public.is_member_of_project(uuid) to anon, authenticated;
-- next_decision_number stays server-only; never called from RLS.
