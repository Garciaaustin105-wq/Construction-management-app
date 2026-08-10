-- Office can delete photos
create policy "Office delete photos" on photos for delete using (
  exists (select 1 from profiles where id = auth.uid() and role = 'office')
);

-- Office can update photo captions (and crew can update their own uploads - optional)
create policy "Office update photos" on photos for update using (
  exists (select 1 from profiles where id = auth.uid() and role = 'office')
);

-- Crew can update their own photo captions
create policy "Crew update own photos" on photos for update using (
  uploaded_by = auth.uid()
);
