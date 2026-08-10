-- Track when each user last viewed each job's activity feed
create table job_views (
  user_id uuid references profiles(id) on delete cascade,
  job_id uuid references jobs on delete cascade,
  last_seen_at timestamp with time zone default now(),
  primary key (user_id, job_id)
);

alter table job_views enable row level security;

-- Users can update their own view records
create policy "Users manage own views" on job_views for all using (
  user_id = auth.uid()
);