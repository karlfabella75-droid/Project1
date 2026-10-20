create table if not exists public.profiles (
	id uuid primary key references auth.users(id) on delete cascade,
	display_name text not null check (char_length(display_name) between 1 and 50),
	username text not null unique,
	created_at timestamptz not null default now()
);

create table if not exists public.posts (
	id uuid primary key default gen_random_uuid(),
	user_id uuid not null references public.profiles(id) on delete cascade,
	category text not null check (category in ('Life Update', 'Study', 'Wins', 'Questions')),
	content text not null check (char_length(content) between 1 and 700),
	created_at timestamptz not null default now()
);

begin;
alter table public.posts drop constraint if exists posts_category_check;
update public.posts set category = 'Life Update' where category = 'Campus';
alter table public.posts add constraint posts_category_check
	check (category in ('Life Update', 'Study', 'Wins', 'Questions'));
commit;

create table if not exists public.comments (
	id uuid primary key default gen_random_uuid(),
	post_id uuid not null references public.posts(id) on delete cascade,
	user_id uuid not null references public.profiles(id) on delete cascade,
	content text not null check (char_length(content) between 1 and 240),
	created_at timestamptz not null default now()
);

create table if not exists public.likes (
	post_id uuid not null references public.posts(id) on delete cascade,
	user_id uuid not null references public.profiles(id) on delete cascade,
	created_at timestamptz not null default now(),
	primary key (post_id, user_id)
);

create table if not exists public.saved_posts (
	post_id uuid not null references public.posts(id) on delete cascade,
	user_id uuid not null references public.profiles(id) on delete cascade,
	created_at timestamptz not null default now(),
	primary key (post_id, user_id)
);

create index if not exists posts_created_at_idx on public.posts (created_at desc);
create index if not exists comments_post_id_created_at_idx on public.comments (post_id, created_at);

create or replace function public.create_commons_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	profile_name text;
begin
	profile_name := coalesce(
		nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''),
		'Student'
	);

	insert into public.profiles (id, display_name, username)
	values (
		new.id,
		left(profile_name, 50),
		'student-' || substr(replace(new.id::text, '-', ''), 1, 8)
	);
	return new;
end;
$$;

drop trigger if exists on_auth_user_created_commons_profile on auth.users;
create trigger on_auth_user_created_commons_profile
	after insert on auth.users
	for each row execute procedure public.create_commons_profile();

alter table public.profiles enable row level security;
alter table public.posts enable row level security;
alter table public.comments enable row level security;
alter table public.likes enable row level security;
alter table public.saved_posts enable row level security;

drop policy if exists "Signed-in members can read profiles" on public.profiles;
drop policy if exists "Members can read study profiles" on public.profiles;
drop policy if exists "Members can update their own profile" on public.profiles;
create policy "Members can update their own profile"
	on public.profiles for update to authenticated
	using ((select auth.uid()) = id)
	with check ((select auth.uid()) = id);

drop policy if exists "Signed-in members can read posts" on public.posts;
create policy "Signed-in members can read posts"
	on public.posts for select to authenticated using (true);
drop policy if exists "Members can create their own posts" on public.posts;
create policy "Members can create their own posts"
	on public.posts for insert to authenticated
	with check ((select auth.uid()) = user_id);
drop policy if exists "Members can edit their own posts" on public.posts;
create policy "Members can edit their own posts"
	on public.posts for update to authenticated
	using ((select auth.uid()) = user_id)
	with check ((select auth.uid()) = user_id);
drop policy if exists "Members can delete their own posts" on public.posts;
create policy "Members can delete their own posts"
	on public.posts for delete to authenticated
	using ((select auth.uid()) = user_id);

drop policy if exists "Signed-in members can read comments" on public.comments;
create policy "Signed-in members can read comments"
	on public.comments for select to authenticated using (true);
drop policy if exists "Members can write their own comments" on public.comments;
create policy "Members can write their own comments"
	on public.comments for insert to authenticated
	with check ((select auth.uid()) = user_id);
drop policy if exists "Members can delete their own comments" on public.comments;
create policy "Members can delete their own comments"
	on public.comments for delete to authenticated
	using ((select auth.uid()) = user_id);

drop policy if exists "Signed-in members can read likes" on public.likes;
create policy "Signed-in members can read likes"
	on public.likes for select to authenticated using (true);
drop policy if exists "Members can like as themselves" on public.likes;
create policy "Members can like as themselves"
	on public.likes for insert to authenticated
	with check ((select auth.uid()) = user_id);
drop policy if exists "Members can remove their own likes" on public.likes;
create policy "Members can remove their own likes"
	on public.likes for delete to authenticated
	using ((select auth.uid()) = user_id);

drop policy if exists "Members can read their saved posts" on public.saved_posts;
create policy "Members can read their saved posts"
	on public.saved_posts for select to authenticated
	using ((select auth.uid()) = user_id);
drop policy if exists "Members can save posts as themselves" on public.saved_posts;
create policy "Members can save posts as themselves"
	on public.saved_posts for insert to authenticated
	with check ((select auth.uid()) = user_id);
drop policy if exists "Members can remove their saved posts" on public.saved_posts;
create policy "Members can remove their saved posts"
	on public.saved_posts for delete to authenticated
	using ((select auth.uid()) = user_id);

grant usage on schema public to authenticated;
grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on public.posts to authenticated;
grant select, insert, delete on public.comments to authenticated;
grant select, insert, delete on public.likes to authenticated;
grant select, insert, delete on public.saved_posts to authenticated;

alter table public.posts alter column user_id drop not null;
alter table public.posts add column if not exists guest_id uuid;
alter table public.posts add column if not exists display_name text;
alter table public.comments alter column user_id drop not null;
alter table public.comments add column if not exists guest_id uuid;
alter table public.comments add column if not exists display_name text;
alter table public.likes add column if not exists id uuid default gen_random_uuid();
update public.likes set id = gen_random_uuid() where id is null;
alter table public.likes alter column id set not null;
alter table public.likes drop constraint if exists likes_pkey;
do $$
begin
	if not exists (
		select 1 from pg_constraint
		where conrelid = 'public.likes'::regclass and contype = 'p'
	) then
		alter table public.likes add primary key (id);
	end if;
end $$;
alter table public.likes alter column user_id drop not null;
alter table public.likes add column if not exists guest_id uuid;

update public.posts post
set display_name = coalesce(profile.display_name, 'Student')
from public.profiles profile
where post.user_id = profile.id and post.display_name is null;
update public.posts
set display_name = 'Student'
where display_name is null;

update public.comments comment
set display_name = coalesce(profile.display_name, 'Student')
from public.profiles profile
where comment.user_id = profile.id and comment.display_name is null;
update public.comments
set display_name = 'Student'
where display_name is null;

create unique index if not exists likes_post_user_unique
	on public.likes (post_id, user_id)
	where user_id is not null;

drop policy if exists "Anyone with the link can read community posts" on public.posts;
drop policy if exists "Guests can add community posts" on public.posts;
drop policy if exists "Anyone with the link can read community replies" on public.comments;
drop policy if exists "Guests can add community replies" on public.comments;
drop policy if exists "Anyone with the link can read hearts" on public.likes;
drop policy if exists "Guests can heart a post once" on public.likes;

revoke all on public.profiles, public.posts, public.comments, public.likes, public.saved_posts from anon;

alter table public.profiles
	add column if not exists avatar_url text,
	add column if not exists cover_url text,
	add column if not exists bio text not null default '',
	add column if not exists courses text[] not null default '{}',
	add column if not exists year_level text not null default '',
	add column if not exists points integer not null default 0,
	add column if not exists is_admin boolean not null default false,
	add column if not exists discoverable boolean not null default true,
	add column if not exists notifications_enabled boolean not null default true,
	add column if not exists settings jsonb not null default '{}'::jsonb,
	add column if not exists updated_at timestamptz not null default now();

alter table public.posts
	add column if not exists image_url text,
	add column if not exists link_url text,
	add column if not exists group_id uuid;

alter table public.comments
	add column if not exists parent_comment_id uuid references public.comments(id) on delete cascade,
	add column if not exists is_helpful boolean not null default false,
	add column if not exists image_url text;

alter table public.posts
	add column if not exists poll_options text[] not null default '{}';

create table if not exists public.poll_votes (
	post_id uuid not null references public.posts(id) on delete cascade,
	user_id uuid not null references public.profiles(id) on delete cascade,
	option_index integer not null check (option_index between 0 and 5),
	created_at timestamptz not null default now(),
	primary key (post_id, user_id)
);

create table if not exists public.follows (
	follower_id uuid not null references public.profiles(id) on delete cascade,
	following_id uuid not null references public.profiles(id) on delete cascade,
	created_at timestamptz not null default now(),
	primary key (follower_id, following_id),
	constraint follows_not_self check (follower_id <> following_id)
);

create table if not exists public.post_bookmarks (
	user_id uuid not null references public.profiles(id) on delete cascade,
	post_id uuid not null references public.posts(id) on delete cascade,
	created_at timestamptz not null default now(),
	primary key (user_id, post_id)
);

create table if not exists public.notifications (
	id uuid primary key default gen_random_uuid(),
	user_id uuid not null references public.profiles(id) on delete cascade,
	actor_id uuid references public.profiles(id) on delete set null,
	kind text not null check (kind in ('like', 'comment', 'reply', 'follow', 'message')),
	post_id uuid references public.posts(id) on delete cascade,
	comment_id uuid references public.comments(id) on delete cascade,
	conversation_id uuid,
	read_at timestamptz,
	created_at timestamptz not null default now(),
	constraint notifications_not_self check (actor_id is null or actor_id <> user_id)
);

create table if not exists public.conversations (
	id uuid primary key default gen_random_uuid(),
	member_a uuid not null references public.profiles(id) on delete cascade,
	member_b uuid not null references public.profiles(id) on delete cascade,
	created_at timestamptz not null default now(),
	constraint conversations_distinct_members check (member_a <> member_b),
	constraint conversations_sorted_members check (member_a < member_b),
	unique (member_a, member_b)
);

create table if not exists public.messages (
	id uuid primary key default gen_random_uuid(),
	conversation_id uuid not null references public.conversations(id) on delete cascade,
	sender_id uuid not null references public.profiles(id) on delete cascade,
	content text not null check (char_length(trim(content)) between 1 and 2000),
	read_at timestamptz,
	created_at timestamptz not null default now()
);

alter table public.messages
	add column if not exists reply_to_id uuid,
	add column if not exists edited_at timestamptz;

do $$
begin
	if not exists (
		select 1 from pg_constraint
		where conrelid = 'public.messages'::regclass
			and conname = 'messages_reply_to_id_fkey'
	) then
		alter table public.messages
			add constraint messages_reply_to_id_fkey
			foreign key (reply_to_id) references public.messages(id) on delete set null;
	end if;
end $$;

create table if not exists public.study_groups (
	id uuid primary key default gen_random_uuid(),
	owner_id uuid not null references public.profiles(id) on delete cascade,
	name text not null check (char_length(trim(name)) between 2 and 80),
	description text not null default '' check (char_length(description) <= 500),
	course text not null default '' check (char_length(course) <= 80),
	created_at timestamptz not null default now()
);

create table if not exists public.study_group_members (
	group_id uuid not null references public.study_groups(id) on delete cascade,
	user_id uuid not null references public.profiles(id) on delete cascade,
	created_at timestamptz not null default now(),
	primary key (group_id, user_id)
);

create table if not exists public.study_group_messages (
	id uuid primary key default gen_random_uuid(),
	group_id uuid not null references public.study_groups(id) on delete cascade,
	user_id uuid not null references public.profiles(id) on delete cascade,
	content text not null check (char_length(trim(content)) between 1 and 2000),
	created_at timestamptz not null default now()
);

create table if not exists public.campus_events (
	id uuid primary key default gen_random_uuid(),
	organizer_id uuid not null references public.profiles(id) on delete cascade,
	title text not null check (char_length(trim(title)) between 2 and 120),
	description text not null default '' check (char_length(description) <= 1000),
	location text not null default '' check (char_length(location) <= 160),
	starts_at timestamptz not null,
	created_at timestamptz not null default now()
);

create table if not exists public.event_attendees (
	event_id uuid not null references public.campus_events(id) on delete cascade,
	user_id uuid not null references public.profiles(id) on delete cascade,
	created_at timestamptz not null default now(),
	primary key (event_id, user_id)
);

create table if not exists public.content_reports (
	id uuid primary key default gen_random_uuid(),
	reporter_id uuid not null references public.profiles(id) on delete cascade,
	post_id uuid references public.posts(id) on delete cascade,
	comment_id uuid references public.comments(id) on delete cascade,
	reported_user_id uuid references public.profiles(id) on delete cascade,
	reason text not null check (char_length(trim(reason)) between 5 and 500),
	status text not null default 'open' check (status in ('open', 'reviewed', 'dismissed')),
	created_at timestamptz not null default now(),
	constraint reports_target_required check (post_id is not null or comment_id is not null or reported_user_id is not null)
);

do $$
begin
	if not exists (select 1 from pg_constraint where conname = 'profiles_bio_length_check' and conrelid = 'public.profiles'::regclass) then
		alter table public.profiles add constraint profiles_bio_length_check check (char_length(bio) <= 280);
	end if;
	if not exists (select 1 from pg_constraint where conname = 'profiles_courses_count_check' and conrelid = 'public.profiles'::regclass) then
		alter table public.profiles add constraint profiles_courses_count_check check (cardinality(courses) <= 8);
	end if;
	if not exists (select 1 from pg_constraint where conname = 'posts_link_scheme_check' and conrelid = 'public.posts'::regclass) then
		alter table public.posts add constraint posts_link_scheme_check check (link_url is null or link_url ~* '^https?://');
	end if;
	if not exists (select 1 from pg_constraint where conname = 'profiles_avatar_https_check' and conrelid = 'public.profiles'::regclass) then
		alter table public.profiles add constraint profiles_avatar_https_check check (avatar_url is null or avatar_url ~* '^https://');
	end if;
	if not exists (select 1 from pg_constraint where conname = 'profiles_cover_https_check' and conrelid = 'public.profiles'::regclass) then
		alter table public.profiles add constraint profiles_cover_https_check check (cover_url is null or cover_url ~* '^https://');
	end if;
	if not exists (select 1 from pg_constraint where conname = 'posts_image_https_check' and conrelid = 'public.posts'::regclass) then
		alter table public.posts add constraint posts_image_https_check check (image_url is null or image_url ~* '^https://');
	end if;
	if not exists (select 1 from pg_constraint where conname = 'comments_image_https_check' and conrelid = 'public.comments'::regclass) then
		alter table public.comments add constraint comments_image_https_check check (image_url is null or image_url ~* '^https://');
	end if;
	if not exists (select 1 from pg_constraint where conname = 'posts_poll_options_count_check' and conrelid = 'public.posts'::regclass) then
		alter table public.posts add constraint posts_poll_options_count_check
			check (coalesce(array_length(poll_options, 1), 0) <= 6 and array_position(poll_options, null) is null);
	end if;
end $$;

do $$
begin
	if not exists (
		select 1 from pg_constraint
		where conrelid = 'public.notifications'::regclass
			and conname = 'notifications_conversation_id_fkey'
	) then
		alter table public.notifications
			add constraint notifications_conversation_id_fkey
			foreign key (conversation_id) references public.conversations(id) on delete cascade;
	end if;
	if not exists (
		select 1 from pg_constraint
		where conrelid = 'public.posts'::regclass
			and conname = 'posts_group_id_fkey'
	) then
		alter table public.posts
			add constraint posts_group_id_fkey
			foreign key (group_id) references public.study_groups(id) on delete set null;
	end if;
end $$;

create index if not exists follows_following_idx on public.follows (following_id, follower_id);
create unique index if not exists one_helpful_answer_per_post_idx on public.comments (post_id) where is_helpful;
create index if not exists notifications_user_unread_idx on public.notifications (user_id, created_at desc) where read_at is null;
create index if not exists messages_conversation_created_idx on public.messages (conversation_id, created_at desc);
create index if not exists group_messages_created_idx on public.study_group_messages (group_id, created_at desc);
create index if not exists campus_events_starts_idx on public.campus_events (starts_at);
create index if not exists post_bookmarks_user_idx on public.post_bookmarks (user_id, created_at desc);

create or replace function public.is_rtt_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select exists (
		select 1 from public.profiles
		where id = (select auth.uid()) and is_admin
	)
$$;

create or replace function public.set_rtt_admin(target_user uuid, make_admin boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
	if not public.is_rtt_admin() then
		raise exception 'Admin access is required.' using errcode = '42501';
	end if;
	if target_user = (select auth.uid()) and not make_admin
		and (select count(*) from public.profiles where is_admin) <= 1 then
		raise exception 'The last RTT administrator cannot remove their own admin role.';
	end if;
	update public.profiles set is_admin = make_admin where id = target_user;
	if not found then
		raise exception 'That member could not be found.';
	end if;
end;
$$;

create or replace function public.add_rtt_points()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	if tg_table_name = 'posts' then
		update public.profiles set points = points + 2 where id = new.user_id;
	elsif tg_table_name = 'comments' then
		update public.profiles set points = points + 1 where id = new.user_id;
	end if;
	return new;
end;
$$;

create or replace function public.award_helpful_answer_points()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	if new.is_helpful and not old.is_helpful then
		update public.profiles set points = points + 5 where id = new.user_id;
	end if;
	return new;
end;
$$;

create or replace function public.limit_rtt_posting_rate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	if exists (
		select 1 from public.posts p
		where p.user_id = new.user_id
			and p.created_at > now() - interval '5 seconds'
	) or exists (
		select 1 from public.comments c
		where c.user_id = new.user_id
			and c.created_at > now() - interval '5 seconds'
	) then
		raise exception 'Please wait a few seconds before posting again.'
			using errcode = 'P0001';
	end if;
	return new;
end;
$$;

drop trigger if exists rtt_post_rate_limit on public.posts;
create trigger rtt_post_rate_limit before insert on public.posts
	for each row when (new.user_id is not null) execute function public.limit_rtt_posting_rate();
drop trigger if exists rtt_comment_rate_limit on public.comments;
create trigger rtt_comment_rate_limit before insert on public.comments
	for each row when (new.user_id is not null) execute function public.limit_rtt_posting_rate();

create or replace function public.limit_rtt_message_rate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	actor_user uuid;
begin
	if tg_table_name = 'messages' then
		actor_user := new.sender_id;
	else
		actor_user := new.user_id;
	end if;
	if exists (
		select 1 from public.messages m
		where m.sender_id = actor_user and m.created_at > now() - interval '3 seconds'
	) or exists (
		select 1 from public.study_group_messages m
		where m.user_id = actor_user and m.created_at > now() - interval '3 seconds'
	) then
		raise exception 'Please wait a few seconds before sending another message.'
			using errcode = 'P0001';
	end if;
	return new;
end;
$$;

create or replace function public.edit_rtt_message(target_message uuid, new_content text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
	if char_length(trim(coalesce(new_content, ''))) not between 1 and 2000 then
		raise exception 'Messages must be between 1 and 2,000 characters.';
	end if;
	update public.messages message
	set content = trim(new_content), edited_at = now()
	where message.id = target_message
		and message.sender_id = (select auth.uid())
		and exists (
			select 1 from public.conversations conversation
			where conversation.id = message.conversation_id
				and (select auth.uid()) in (conversation.member_a, conversation.member_b)
		);
	if not found then
		raise exception 'You can only edit your own messages in conversations you belong to.';
	end if;
	return true;
end;
$$;

drop trigger if exists rtt_message_rate_limit on public.messages;
create trigger rtt_message_rate_limit before insert on public.messages
	for each row execute function public.limit_rtt_message_rate();
drop trigger if exists rtt_group_message_rate_limit on public.study_group_messages;
create trigger rtt_group_message_rate_limit before insert on public.study_group_messages
	for each row execute function public.limit_rtt_message_rate();

drop trigger if exists rtt_post_points on public.posts;
create trigger rtt_post_points after insert on public.posts
	for each row when (new.user_id is not null) execute function public.add_rtt_points();
drop trigger if exists rtt_comment_points on public.comments;
create trigger rtt_comment_points after insert on public.comments
	for each row when (new.user_id is not null) execute function public.add_rtt_points();
drop trigger if exists rtt_helpful_answer_points on public.comments;
create trigger rtt_helpful_answer_points after update of is_helpful on public.comments
	for each row execute function public.award_helpful_answer_points();

create or replace function public.notify_rtt_social_activity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	post_owner uuid;
	comment_owner uuid;
	target_user uuid;
	actor_user uuid;
	recipient_enabled boolean;
	recipient_settings jsonb;
	preference_enabled boolean;
	notification_kind text;
begin
	if tg_table_name = 'likes' then
		select p.user_id, profile.notifications_enabled, profile.settings
		into target_user, recipient_enabled, recipient_settings
		from public.posts p join public.profiles profile on profile.id = p.user_id
		where p.id = new.post_id;
		actor_user := new.user_id;
		notification_kind := 'like';
	elsif tg_table_name = 'comments' then
		select user_id into post_owner from public.posts where id = new.post_id;
		if new.parent_comment_id is not null then
			select user_id into comment_owner from public.comments where id = new.parent_comment_id;
		end if;
		target_user := coalesce(comment_owner, post_owner);
		notification_kind := case when comment_owner is null then 'comment' else 'reply' end;
		select notifications_enabled, settings into recipient_enabled, recipient_settings
		from public.profiles where id = target_user;
		actor_user := new.user_id;
	elsif tg_table_name = 'follows' then
		target_user := new.following_id;
		select notifications_enabled, settings into recipient_enabled, recipient_settings
		from public.profiles where id = target_user;
		actor_user := new.follower_id;
		notification_kind := 'follow';
	elsif tg_table_name = 'messages' then
		select case when member_a = new.sender_id then member_b else member_a end
		into target_user from public.conversations where id = new.conversation_id;
		select notifications_enabled, settings into recipient_enabled, recipient_settings
		from public.profiles where id = target_user;
		actor_user := new.sender_id;
		notification_kind := 'message';
	end if;

	preference_enabled := case notification_kind
		when 'like' then coalesce(recipient_settings ->> 'notify_likes' <> 'false', true)
		when 'comment' then coalesce(recipient_settings ->> 'notify_comments' <> 'false', true)
		when 'reply' then coalesce(recipient_settings ->> 'notify_comments' <> 'false', true)
		when 'follow' then coalesce(recipient_settings ->> 'notify_follows' <> 'false', true)
		when 'message' then coalesce(recipient_settings ->> 'notify_messages' <> 'false', true)
		else true
	end;
	if target_user is null or target_user = actor_user or coalesce(recipient_enabled, true) = false or not preference_enabled then
		return new;
	end if;
	if tg_table_name = 'likes' then
		insert into public.notifications (user_id, actor_id, kind, post_id)
		values (target_user, actor_user, notification_kind, new.post_id);
	elsif tg_table_name = 'comments' then
		insert into public.notifications (user_id, actor_id, kind, post_id, comment_id)
		values (target_user, actor_user, notification_kind, new.post_id, new.id);
	elsif tg_table_name = 'follows' then
		insert into public.notifications (user_id, actor_id, kind)
		values (target_user, actor_user, notification_kind);
	elsif tg_table_name = 'messages' then
		insert into public.notifications (user_id, actor_id, kind, conversation_id)
		values (target_user, actor_user, notification_kind, new.conversation_id);
	end if;
	return new;
end;
$$;

drop trigger if exists rtt_notify_like on public.likes;
create trigger rtt_notify_like after insert on public.likes
	for each row when (new.user_id is not null) execute function public.notify_rtt_social_activity();
drop trigger if exists rtt_notify_comment on public.comments;
create trigger rtt_notify_comment after insert on public.comments
	for each row when (new.user_id is not null) execute function public.notify_rtt_social_activity();
drop trigger if exists rtt_notify_follow on public.follows;
create trigger rtt_notify_follow after insert on public.follows
	for each row execute function public.notify_rtt_social_activity();
drop trigger if exists rtt_notify_message on public.messages;
create trigger rtt_notify_message after insert on public.messages
	for each row execute function public.notify_rtt_social_activity();

alter table public.follows enable row level security;
alter table public.post_bookmarks enable row level security;
alter table public.notifications enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.study_groups enable row level security;
alter table public.study_group_members enable row level security;
alter table public.study_group_messages enable row level security;
alter table public.campus_events enable row level security;
alter table public.event_attendees enable row level security;
alter table public.content_reports enable row level security;
alter table public.poll_votes enable row level security;

drop policy if exists "Members can read study profiles" on public.profiles;
create policy "Members can read study profiles" on public.profiles for select to authenticated
	using (id = (select auth.uid()) or discoverable or (select public.is_rtt_admin()));
drop policy if exists "Members can update profile settings" on public.profiles;
create policy "Members can update profile settings" on public.profiles for update to authenticated
	using ((select auth.uid()) = id) with check ((select auth.uid()) = id);
drop policy if exists "Owners or admins can update community posts" on public.posts;
create policy "Owners or admins can update community posts" on public.posts for update to authenticated
	using ((select auth.uid()) = user_id or (select public.is_rtt_admin()))
	with check ((select auth.uid()) = user_id or (select public.is_rtt_admin()));
drop policy if exists "Owners or admins can remove community posts" on public.posts;
create policy "Owners or admins can remove community posts" on public.posts for delete to authenticated
	using ((select auth.uid()) = user_id or (select public.is_rtt_admin()));
drop policy if exists "Members can reply to community posts" on public.comments;
create policy "Members can reply to community posts" on public.comments for insert to authenticated
	with check ((select auth.uid()) = user_id);
drop policy if exists "Members can edit their replies" on public.comments;
create policy "Members can edit their replies" on public.comments for update to authenticated
	using (
		exists (select 1 from public.posts p where p.id = comments.post_id and p.user_id = (select auth.uid()))
		or (select public.is_rtt_admin())
	)
	with check (
		exists (select 1 from public.posts p where p.id = comments.post_id and p.user_id = (select auth.uid()))
		or (select public.is_rtt_admin())
	);
drop policy if exists "Owners or admins can remove replies" on public.comments;
create policy "Owners or admins can remove replies" on public.comments for delete to authenticated
	using ((select auth.uid()) = user_id or (select public.is_rtt_admin()));

drop policy if exists "Members can read follows" on public.follows;
create policy "Members can read follows" on public.follows for select to authenticated using (true);
drop policy if exists "Members can follow other users" on public.follows;
create policy "Members can follow other users" on public.follows for insert to authenticated
	with check ((select auth.uid()) = follower_id and follower_id <> following_id);
drop policy if exists "Members can unfollow users" on public.follows;
create policy "Members can unfollow users" on public.follows for delete to authenticated
	using ((select auth.uid()) = follower_id);

drop policy if exists "Members can read their bookmarks" on public.post_bookmarks;
create policy "Members can read their bookmarks" on public.post_bookmarks for select to authenticated
	using ((select auth.uid()) = user_id);
drop policy if exists "Members can create their bookmarks" on public.post_bookmarks;
create policy "Members can create their bookmarks" on public.post_bookmarks for insert to authenticated
	with check ((select auth.uid()) = user_id);
drop policy if exists "Members can remove their bookmarks" on public.post_bookmarks;
create policy "Members can remove their bookmarks" on public.post_bookmarks for delete to authenticated
	using ((select auth.uid()) = user_id);
drop policy if exists "Members can read poll votes" on public.poll_votes;
create policy "Members can read poll votes" on public.poll_votes for select to authenticated using (true);
drop policy if exists "Members can vote once on each poll" on public.poll_votes;
create policy "Members can vote once on each poll" on public.poll_votes for insert to authenticated
	with check ((select auth.uid()) = user_id and option_index < (
		select coalesce(array_length(p.poll_options, 1), 0)
		from public.posts p where p.id = post_id
	));

drop policy if exists "Members can read their notifications" on public.notifications;
create policy "Members can read their notifications" on public.notifications for select to authenticated
	using ((select auth.uid()) = user_id);
drop policy if exists "Members can update their notifications" on public.notifications;
create policy "Members can update their notifications" on public.notifications for update to authenticated
	using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists "Members can read their conversations" on public.conversations;
create policy "Members can read their conversations" on public.conversations for select to authenticated
	using ((select auth.uid()) in (member_a, member_b));
drop policy if exists "Members can start conversations" on public.conversations;
create policy "Members can start conversations" on public.conversations for insert to authenticated
	with check (
		(select auth.uid()) in (member_a, member_b)
		and member_a < member_b
	);
drop policy if exists "Members can read conversation messages" on public.messages;
create policy "Members can read conversation messages" on public.messages for select to authenticated
	using (exists (
		select 1 from public.conversations c
		where c.id = conversation_id and (select auth.uid()) in (c.member_a, c.member_b)
	));
drop policy if exists "Members can send conversation messages" on public.messages;
create policy "Members can send conversation messages" on public.messages for insert to authenticated
	with check (
		(select auth.uid()) = sender_id
		and exists (
			select 1 from public.conversations c
			where c.id = conversation_id and (select auth.uid()) in (c.member_a, c.member_b)
		)
		and (
			reply_to_id is null
			or exists (
				select 1 from public.messages original
				where original.id = reply_to_id and original.conversation_id = messages.conversation_id
			)
		)
	);
drop policy if exists "Members can mark received messages read" on public.messages;
create policy "Members can mark received messages read" on public.messages for update to authenticated
	using (
		sender_id <> (select auth.uid())
		and exists (
			select 1 from public.conversations c
			where c.id = conversation_id and (select auth.uid()) in (c.member_a, c.member_b)
		)
	)
	with check (sender_id <> (select auth.uid()));
drop policy if exists "Members can delete their own conversation messages" on public.messages;
create policy "Members can delete their own conversation messages" on public.messages for delete to authenticated
	using (
		sender_id = (select auth.uid())
		and exists (
			select 1 from public.conversations c
			where c.id = conversation_id and (select auth.uid()) in (c.member_a, c.member_b)
		)
	);

drop policy if exists "Members can browse study groups" on public.study_groups;
create policy "Members can browse study groups" on public.study_groups for select to authenticated using (true);
drop policy if exists "Members can create study groups" on public.study_groups;
create policy "Members can create study groups" on public.study_groups for insert to authenticated
	with check ((select auth.uid()) = owner_id);
DROP POLICY IF EXISTS "Owners or admins can update study groups"
ON public.study_groups;

CREATE POLICY "Owners or admins can update study groups"
ON public.study_groups
FOR UPDATE
TO authenticated
USING (
    (SELECT auth.uid()) = owner_id
    OR (SELECT public.is_rtt_admin())
)
WITH CHECK (
    (SELECT auth.uid()) = owner_id
    OR (SELECT public.is_rtt_admin())
);
drop policy if exists "Owners or admins can remove study groups" on public.study_groups;
create policy "Owners or admins can remove study groups" on public.study_groups for delete to authenticated
	using ((select auth.uid()) = owner_id or (select public.is_rtt_admin()));
drop policy if exists "Members can read group membership" on public.study_group_members;
create policy "Members can read group membership" on public.study_group_members for select to authenticated using (true);
drop policy if exists "Members can join groups" on public.study_group_members;
create policy "Members can join groups" on public.study_group_members for insert to authenticated
	with check ((select auth.uid()) = user_id);
drop policy if exists "Members can leave groups" on public.study_group_members;
create policy "Members can leave groups" on public.study_group_members for delete to authenticated
	using ((select auth.uid()) = user_id or exists (
		select 1 from public.study_groups g
		where g.id = group_id and (select auth.uid()) = g.owner_id
	));
drop policy if exists "Group members can read discussions" on public.study_group_messages;
create policy "Group members can read discussions" on public.study_group_messages for select to authenticated
	using (exists (
		select 1 from public.study_group_members m
		where m.group_id = study_group_messages.group_id and m.user_id = (select auth.uid())
	));
drop policy if exists "Group members can write discussions" on public.study_group_messages;
create policy "Group members can write discussions" on public.study_group_messages for insert to authenticated
	with check ((select auth.uid()) = user_id and exists (
		select 1 from public.study_group_members m
		where m.group_id = study_group_messages.group_id and m.user_id = (select auth.uid())
	));

drop policy if exists "Members can browse campus events" on public.campus_events;
create policy "Members can browse campus events" on public.campus_events for select to authenticated using (true);
drop policy if exists "Members can create campus events" on public.campus_events;
create policy "Members can create campus events" on public.campus_events for insert to authenticated
	with check ((select auth.uid()) = organizer_id);
drop policy if exists "Owners or admins can update campus events" on public.campus_events;
create policy "Owners or admins can update campus events" on public.campus_events for update to authenticated
	using ((select auth.uid()) = organizer_id or (select public.is_rtt_admin()))
	with check ((select auth.uid()) = organizer_id or (select public.is_rtt_admin()));
drop policy if exists "Owners or admins can remove campus events" on public.campus_events;
create policy "Owners or admins can remove campus events" on public.campus_events for delete to authenticated
	using ((select auth.uid()) = organizer_id or (select public.is_rtt_admin()));
drop policy if exists "Members can read event attendance" on public.event_attendees;
create policy "Members can read event attendance" on public.event_attendees for select to authenticated using (true);
drop policy if exists "Members can attend events" on public.event_attendees;
create policy "Members can attend events" on public.event_attendees for insert to authenticated
	with check ((select auth.uid()) = user_id);
drop policy if exists "Members can cancel attendance" on public.event_attendees;
create policy "Members can cancel attendance" on public.event_attendees for delete to authenticated
	using ((select auth.uid()) = user_id);

drop policy if exists "Members can submit content reports" on public.content_reports;
create policy "Members can submit content reports" on public.content_reports for insert to authenticated
	with check ((select auth.uid()) = reporter_id);
drop policy if exists "Admins can review content reports" on public.content_reports;
create policy "Admins can review content reports" on public.content_reports for select to authenticated
	using ((select public.is_rtt_admin()));
drop policy if exists "Admins can update content reports" on public.content_reports;
create policy "Admins can update content reports" on public.content_reports for update to authenticated
	using ((select public.is_rtt_admin())) with check ((select public.is_rtt_admin()));

revoke update on public.profiles from authenticated;
grant select on public.profiles to authenticated;
grant update (display_name, username, avatar_url, cover_url, bio, courses, year_level, discoverable, notifications_enabled, settings, updated_at) on public.profiles to authenticated;
grant select, insert, update, delete on public.posts to authenticated;
revoke update on public.comments from authenticated;
grant select, insert, delete on public.comments to authenticated;
grant update (is_helpful) on public.comments to authenticated;
grant select, insert, delete on public.follows, public.post_bookmarks, public.event_attendees to authenticated;
grant select, insert on public.poll_votes to authenticated;
grant select on public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;
grant select, insert on public.conversations, public.messages to authenticated;
revoke update on public.messages from public, anon, authenticated;
grant update (read_at) on public.messages to authenticated;
grant delete on public.messages to authenticated;
revoke execute on function public.edit_rtt_message(uuid, text) from public;
grant execute on function public.edit_rtt_message(uuid, text) to authenticated;
grant select, insert, update, delete on public.study_groups to authenticated;
grant select, insert, delete on public.study_group_members to authenticated;
grant select, insert on public.study_group_messages to authenticated;
grant select, insert, update, delete on public.campus_events to authenticated;
grant insert, select, update on public.content_reports to authenticated;
grant execute on function public.is_rtt_admin() to authenticated;
revoke all on function public.set_rtt_admin(uuid, boolean) from public;
grant execute on function public.set_rtt_admin(uuid, boolean) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('rtt-media', 'rtt-media', true, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do update set
	public = excluded.public,
	file_size_limit = excluded.file_size_limit,
	allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "RTT members can read media" on storage.objects;
create policy "RTT members can read media" on storage.objects for select to authenticated
	using (bucket_id = 'rtt-media');
drop policy if exists "RTT members can upload their own media" on storage.objects;
create policy "RTT members can upload their own media" on storage.objects for insert to authenticated
	with check (
		bucket_id = 'rtt-media'
		and (storage.foldername(name))[1] = (select auth.uid())::text
		and lower(storage.extension(name)) in ('jpg', 'jpeg', 'png', 'webp', 'gif')
	);
drop policy if exists "RTT members can update their own media" on storage.objects;
create policy "RTT members can update their own media" on storage.objects for update to authenticated
	using (bucket_id = 'rtt-media' and (storage.foldername(name))[1] = (select auth.uid())::text)
	with check (bucket_id = 'rtt-media' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "RTT members can delete their own media" on storage.objects;
create policy "RTT members can delete their own media" on storage.objects for delete to authenticated
	using (bucket_id = 'rtt-media' and (storage.foldername(name))[1] = (select auth.uid())::text);

do $$
declare
	table_name text;
begin
	if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
		foreach table_name in array array['posts', 'notifications', 'messages', 'likes', 'comments', 'follows'] loop
			if not exists (
				select 1 from pg_publication_tables
				where pubname = 'supabase_realtime'
					and schemaname = 'public'
					and tablename = table_name
			) then
				execute format('alter publication supabase_realtime add table public.%I', table_name);
			end if;
		end loop;
	end if;
end $$;
