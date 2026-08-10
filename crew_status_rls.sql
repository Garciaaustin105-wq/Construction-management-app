-- Assigned crew can update job status (but not other fields)
create policy "Crew update assigned job status" on jobs for update using (
  auth.uid() = any(assigned_crew)
) with check (
  auth.uid() = any(assigned_crew)
);