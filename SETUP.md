# RTT — Run Time Terrors

RTT is a student community site built with static HTML/CSS/JavaScript and Supabase. It uses Supabase Auth for accounts, Postgres with row-level security for shared data, Supabase Storage for images, and Supabase Realtime for social updates and online presence.

## Supabase setup

1. In Supabase, create a project and copy the **Project URL** and **publishable key** (or legacy anon key) from **Project Settings → API**.
2. Add both values to `supabase-config.js`. The website needs the publishable/anon key; **never put a `service_role` or secret key in client-side code**.
3. Open the Supabase **SQL Editor**, run the complete `supabase-schema.sql` script, and check that the query finishes without errors. The script extends the existing RTT schema and is designed to be safe to run again.
4. In **Project Settings → API → Exposed schemas**, expose `public` to the Data API.
5. In **Authentication → URL Configuration**, add the published HTTPS address to **Site URL** and **Redirect URLs**. Configure email confirmation and email delivery under **Authentication → Providers → Email**.
6. The schema creates the `rtt-media` public image bucket with a 5 MB image limit and per-user upload paths. Profile, post, and comment images are public URLs; do not upload private images.
7. The schema adds posts, comments, likes, follows, notifications, and messages to `supabase_realtime` when that publication exists. If realtime is disabled in the project, enable those tables in **Database → Publications → supabase_realtime**.
8. To make the first moderator, sign in with that account, then run this once in the SQL Editor, replacing the email with the exact account email:

   ```sql
   update public.profiles
   set is_admin = true
   where id = (select id from auth.users where email = 'moderator@example.com');
   ```

   Admin membership is separate from regular sign-up; never expose a secret key to promote moderators.

## Features

- Email/password sign-up and sign-in, profile editing, profile/cover images, courses, year level, bio, profile visibility controls, password/email changes, and display preferences.
- Shared feed with category filters, following/trending/recent/bookmarked views, post editing/deletion, image uploads on posts and comments, links, polls, hashtags, mentions, likes, threaded replies, helpful answers, and reports.
- The post categories are Life Update, Study, Wins, and Questions.
- Student search, follows, RTT points and achievement badges, study groups with member-only discussions, and campus events with RSVPs.
- Private one-to-one messages with realtime updates, online presence from Supabase Realtime, unread counts, reply/edit/delete controls for your own messages, emoji insertion, and older-message paging.
- RTT Forge (graphite navy with copper accents), Midnight Steel, Emerald, Violet, Rose, and Light Mode themes; account-saved accent, layout, font size, privacy, accessibility, and notification preferences.
- Account settings for email/password changes, profile discoverability and display controls, per-activity notifications, reduced motion, compact feed, high contrast, and an export of your RTT profile and activity as JSON.
- Admin tools for member role changes, report review, and content removal. Database row-level security checks permissions; a small server-side posting cooldown helps limit spam.

## Publish

Publish `index.html`, `style.css`, `script.js`, and `supabase-config.js` to a static HTTPS host. Opening the files locally is only a local preview, not a link your friends can use. Share the published URL after the Supabase setup is complete.

## Current boundaries

- The client shows up to 100 recent posts per feed load. Conversation history is displayed in pages of 50 messages.
- The image bucket is public, and the application does not resize images. Post and comment photos can be viewed by anyone with their image URL; only upload images intended for public sharing.
- Data exports are created in your browser and include private messages. Store the downloaded JSON file securely.
- Admin tools support moderator roles, reports, and removing posts/replies. Account bans, email delivery of notifications, attachments other than images, and external link unfurling require additional server-side services and are not included.
- Muting and archiving a conversation currently affect only this browser/device. Typing indicators are intentionally not shown because the existing schema does not provide reliable typing state. Deleting a conversation is not offered because it would erase shared message history for both participants; you can delete your own individual messages.
- The updated `supabase-schema.sql` safely converts existing `Campus` post categories to `Life Update` before enforcing the four supported category values. Run the complete updated script in the SQL Editor; it also adds the reply/edit message columns, secure edit function, and sender-only message deletion policy. Do this before using the new messaging controls.
- Post and comment photos require `posts.image_url`, `comments.image_url`, the `rtt-media` bucket, and its authenticated upload policy. If an upload reports a missing column, bucket, or storage permission, run the complete updated schema script in Supabase SQL Editor and reload the site.
- Study sessions can be posted as campus events; calendar invitations and recurring schedules are not implemented.
- Posts and profiles are visible to authenticated members according to the database privacy setting. Never post sensitive personal information.
