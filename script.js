(() => {
	const config = window.COMMONS_CONFIG;
	const hasConfig = config
		&& typeof config.url === "string"
		&& config.url.startsWith("https://")
		&& !config.url.includes("YOUR-PROJECT")
		&& typeof config.anonKey === "string"
		&& config.anonKey.length > 20
		&& !config.anonKey.startsWith("YOUR_")
		&& !config.anonKey.includes("xxxxxxxx");
	const feed = document.getElementById("post-feed");
	const postForm = document.getElementById("post-form");
	const searchInput = document.getElementById("search-input");
	const featureView = document.getElementById("feature-view");
	const filterButtons = [...document.querySelectorAll("[data-filter]")];
	const palette = ["#e6ebdf", "#f3e6d8", "#e9e5ee", "#e4ebee", "rgb(12, 12, 12)"];
	const SAVED_POSTS_KEY = "the-commons-saved-posts-v1";
	let activeFilter = "all";
	let activeView = "feed";
	let activeConversationId = "";
	let activeMessagePage = 0;
	let messageFilter = "all";
	let messageQuery = "";
	let posts = [];
	let userId = null;
	let displayName = null;
	let currentProfile = null;
	let adminSearchQuery = "";
	let followingIds = new Set();
	let bookmarkIds = new Set();
	let onlineUsers = new Set();
	let realtimeSubscription = null;
	let supabaseClient = null;
	let refreshTimer = null;
	let messageRefreshTimer = null;
	let messageRefreshPending = false;
	let signedInEmail = "";
	const themeAccents = {
		amber: "#c47b35",
		midnight: "#7192b5",
		emerald: "#4fc49a",
		violet: "#ad8cff",
		rose: "#f17ca5",
		light: "#d9812b"
	};
	const allowedThemes = ["amber", "midnight", "emerald", "violet", "rose", "light"];
	const postCategories = ["Life Update", "Study", "Wins", "Questions"];

	function readPreferenceSet(key) {
		try {
			const value = JSON.parse(getPreference(key) || "[]");
			return new Set(Array.isArray(value) ? value.filter((item) => typeof item === "string") : []);
		} catch (error) {
			console.error(`Could not parse preference "${key}"`, error);
			return new Set();
		}
	}

	function savePreferenceSet(key, values) {
		setPreference(key, JSON.stringify([...values]));
	}

	function getMutedConversationIds() {
		return [...readPreferenceSet("rtt-muted-conversations")]
			.filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id));
	}

	function setJoinMessage(message, success = false) {
		const status = document.getElementById("join-status");
		status.textContent = message;
		status.classList.toggle("success", success);
	}

	function setFeedMessage(message, success = false) {
		const status = document.getElementById("form-status");
		status.textContent = message;
		status.classList.toggle("success", success);
	}

	function errorMessage(error, fallback) {
		console.error(fallback, error);
		return error && typeof error.message === "string" ? error.message : fallback;
	}

	function cleanSearchTerm(value) {
		return String(value || "").trim().replace(/[^\p{L}\p{N}_# @.-]/gu, "").slice(0, 80);
	}

	function safeImageUrl(value) {
		try {
			const url = new URL(String(value || ""));
			return url.protocol === "https:" ? url.href : "";
		} catch {
			return "";
		}
	}

	function getPreference(key) {
		try {
			return localStorage.getItem(key);
		} catch (error) {
			console.error(`Could not read preference "${key}"`, error);
			return null;
		}
	}

	function setPreference(key, value) {
		try {
			localStorage.setItem(key, value);
		} catch (error) {
			throw new Error(`Could not save this device preference: ${error.message || "browser storage is unavailable."}`);
		}
	}

	function applyDevicePreferences(accountSettings = currentProfile?.settings || {}) {
		const theme = accountSettings.theme || getPreference("rtt-theme") || "amber";
		const savedAccent = accountSettings.accent || getPreference("rtt-accent") || "amber";
		const legacyAccents = { orange: "amber", teal: "emerald", blue: "midnight" };
		const accent = legacyAccents[savedAccent] || savedAccent;
		const selectedTheme = allowedThemes.includes(theme) ? theme : "amber";
		const selectedAccent = Object.prototype.hasOwnProperty.call(themeAccents, accent) ? accent : selectedTheme;
		document.body.dataset.theme = selectedTheme;
		document.body.dataset.accent = selectedAccent;
		document.documentElement.style.setProperty("--accent", themeAccents[selectedAccent]);
		document.body.classList.toggle("reduce-motion", getPreference("rtt-reduced-motion") === "true");
		document.body.classList.toggle("compact-feed", getPreference("rtt-compact-feed") === "true");
		document.body.dataset.fontSize = ["small", "default", "large"].includes(accountSettings.font_size || getPreference("rtt-font-size"))
			? accountSettings.font_size || getPreference("rtt-font-size")
			: "default";
		document.body.classList.toggle("large-text", document.body.dataset.fontSize === "large");
		document.body.classList.toggle("small-text", document.body.dataset.fontSize === "small");
		document.body.classList.toggle("high-contrast", getPreference("rtt-high-contrast") === "true");
		document.body.classList.toggle("comfortable-layout", (accountSettings.layout || getPreference("rtt-layout")) !== "compact");
		document.body.classList.toggle("compact-layout", (accountSettings.layout || getPreference("rtt-layout")) === "compact");
	}

	function enterCommunity(user, profile) {
		userId = user.id;
		currentProfile = profile;
		applyDevicePreferences(profile.settings || {});
		signedInEmail = user.email || "";
		displayName = profile.display_name || user.user_metadata?.display_name || "Student";
		const name = displayName;
		const initial = Array.from(name.trim())[0]?.toUpperCase() || "S";
		document.getElementById("join-screen").hidden = true;
		document.getElementById("app-shell").hidden = false;
		document.getElementById("signed-in-name").textContent = name;
		document.getElementById("signed-in-avatar").textContent = initial;
		document.getElementById("composer-avatar").textContent = initial;
		setProfileImages(profile);
		document.getElementById("post-form").hidden = false;
		document.querySelector(".admin-nav-item").hidden = !profile.is_admin;
		feed.replaceChildren(...Array.from({ length: 3 }, () => makeElement("div", "skeleton")));
		void loadSocialContext();
		void loadPosts();
		if (refreshTimer) clearInterval(refreshTimer);
		refreshTimer = setInterval(() => {
			if (activeView === "feed") void loadPosts();
			void updateActivityCounts();
		}, 30000);
		if (realtimeSubscription) void supabaseClient.removeChannel(realtimeSubscription);
		realtimeSubscription = supabaseClient.channel("rtt-social-live")
			.on("presence", { event: "sync" }, () => {
				const presence = realtimeSubscription.presenceState();
				onlineUsers = new Set(Object.values(presence).flat().map((entry) => entry.user_id));
				document.querySelectorAll("[data-presence-user]").forEach((indicator) => {
					indicator.classList.toggle("online", onlineUsers.has(indicator.dataset.presenceUser));
				});
				document.querySelectorAll("[data-presence-label]").forEach((label) => {
					label.textContent = `@${label.dataset.username} · ${onlineUsers.has(label.dataset.presenceLabel) ? "Online" : "Offline"}`;
				});
				if (activeView === "messages" && messageFilter === "online") {
					void showView("messages", activeConversationId);
				}
			})
			.on("postgres_changes", { event: "*", schema: "public", table: "posts" }, () => {
				if (activeView === "feed") void loadPosts();
			})
			.on("postgres_changes", { event: "*", schema: "public", table: "notifications", filter: `user_id=eq.${userId}` }, () => {
				void updateActivityCounts();
				if (activeView === "notifications") void showView("notifications");
			})
			.on("postgres_changes", { event: "*", schema: "public", table: "messages" }, () => {
				void updateActivityCounts();
				const composer = featureView.querySelector('form[data-feature-form="send-message"] textarea');
				if (activeView === "messages" && document.activeElement === composer) {
					messageRefreshPending = true;
				} else if (activeView === "messages") {
					messageRefreshPending = false;
					clearTimeout(messageRefreshTimer);
					messageRefreshTimer = setTimeout(() => {
						void showView("messages", activeConversationId);
					}, 180);
				}
			})
			.subscribe((status) => {
				if (status === "SUBSCRIBED") {
					void realtimeSubscription.track({ user_id: userId, online_at: new Date().toISOString() });
				}
			});
	}

	function makeElement(tag, className, text) {
		const element = document.createElement(tag);
		if (className) element.className = className;
		if (text !== undefined) element.textContent = text;
		return element;
	}

	function makeAvatar(initial, color, extraClass = "") {
		const avatar = makeElement("div", `avatar ${extraClass}`, initial);
		avatar.style.backgroundColor = color || "#e0eadb";
		avatar.setAttribute("aria-hidden", "true");
		return avatar;
	}

	function releaseCommentPreviews(container) {
		container.querySelectorAll(".comment-image-preview[data-object-url]").forEach((preview) => {
			URL.revokeObjectURL(preview.dataset.objectUrl);
			delete preview.dataset.objectUrl;
		});
	}

	async function fetchAllRows(createQuery) {
		const rows = [];
		const pageSize = 1000;
		for (let offset = 0; ; offset += pageSize) {
			const { data, error } = await createQuery().range(offset, offset + pageSize - 1);
			if (error) throw error;
			rows.push(...data);
			if (data.length < pageSize) return rows;
		}
	}

	function formatTime(timestamp) {
		const elapsed = Math.max(0, Date.now() - new Date(timestamp).getTime());
		const minutes = Math.floor(elapsed / 60000);
		if (minutes < 1) return "just now";
		if (minutes < 60) return `${minutes}m ago`;
		const hours = Math.floor(minutes / 60);
		if (hours < 24) return `${hours}h ago`;
		const days = Math.floor(hours / 24);
		if (days < 7) return `${days}d ago`;
		return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(timestamp));
	}

	function normalizePost(row) {
		const displayName = row.profiles?.display_name || row.display_name || "Student";
		const comments = (row.comments || []).map((comment) => {
			const commentName = comment.profiles?.display_name || comment.display_name || "Student";
			return {
				id: comment.id,
				name: commentName,
				userId: comment.user_id,
				avatarUrl: comment.profiles?.avatar_url,
				imageUrl: comment.image_url,
				initial: Array.from(commentName.trim())[0]?.toUpperCase() || "S",
				text: comment.content,
				parentId: comment.parent_comment_id,
				helpful: comment.is_helpful,
				createdAt: comment.created_at
			};
		});
		return {
			id: row.id,
			userId: row.user_id,
			name: displayName,
			initial: Array.from(displayName.trim())[0]?.toUpperCase() || "S",
			avatarUrl: row.profiles?.avatar_url,
			handle: `member-${String(row.user_id || row.guest_id || "").replaceAll("-", "").slice(0, 4)}`,
			avatarColor: palette[Array.from(displayName).reduce((sum, letter) => sum + letter.charCodeAt(0), 0) % palette.length],
			category: row.category,
			content: row.content,
			imageUrl: row.image_url,
			linkUrl: row.link_url,
			pollOptions: row.poll_options || [],
			pollVotes: row.poll_votes || [],
			createdAt: row.created_at,
			likes: row.likes || [],
			liked: (row.likes || []).some((like) => like.user_id === userId),
			saved: bookmarkIds.has(row.id) || loadSavedPosts().includes(row.id),
			comments
		};
	}

	function loadSavedPosts() {
		try {
			const stored = JSON.parse(localStorage.getItem(SAVED_POSTS_KEY) || "[]");
			return Array.isArray(stored) && stored.every((id) => typeof id === "string") ? stored : [];
		} catch (error) {
			console.error("Could not load saved posts", error);
			return [];
		}
	}

	function saveSavedPosts(savedPosts) {
		try {
			localStorage.setItem(SAVED_POSTS_KEY, JSON.stringify(savedPosts));
			return true;
		} catch (error) {
			setFeedMessage(`Could not save this post on your device: ${errorMessage(error, "Browser storage is unavailable.")}`);
			return false;
		}
	}

	function makeComment(comment) {
		const row = makeElement("div", "comment");
		row.append(makeProfileImage(comment.avatarUrl, comment.name));
		const bubble = makeElement("div", "comment-bubble");
		bubble.append(makeElement("strong", "", comment.name), document.createTextNode(comment.text));
		const imageUrl = safeImageUrl(comment.imageUrl);
		if (imageUrl) {
			const imageLink = makeElement("a", "comment-image-link");
			imageLink.href = imageUrl;
			imageLink.target = "_blank";
			imageLink.rel = "noopener noreferrer";
			const image = makeElement("img", "comment-image");
			image.src = imageUrl;
			image.alt = "Photo attached to this comment";
			image.loading = "lazy";
			imageLink.append(image);
			bubble.append(imageLink);
		}
		if (comment.helpful) bubble.append(makeElement("small", "helpful-badge", " · HELPFUL"));
		const actions = makeElement("div", "comment-actions");
		if (comment.parentId) row.classList.add("nested-comment");
		const replyButton = makeElement("button", "text-button", "Reply");
		replyButton.type = "button";
		replyButton.dataset.action = "reply-comment";
		replyButton.dataset.commentId = comment.id;
		replyButton.dataset.postId = comment.postId;
		actions.append(replyButton);
		if (comment.userId === userId) {
			const remove = makeElement("button", "text-button", "Delete");
			remove.type = "button";
			remove.dataset.action = "delete-comment";
			remove.dataset.commentId = comment.id;
			remove.dataset.postId = comment.postId;
			actions.append(remove);
		} else {
			const report = makeElement("button", "text-button", "Report");
			report.type = "button";
			report.dataset.action = "report-comment";
			report.dataset.commentId = comment.id;
			report.dataset.postId = comment.postId;
			actions.append(report);
		}
		if (comment.canMarkHelpful && !comment.helpful) {
			const helpfulButton = makeElement("button", "text-button", "Helpful");
			helpfulButton.type = "button";
			helpfulButton.dataset.action = "helpful-comment";
			helpfulButton.dataset.commentId = comment.id;
			actions.append(helpfulButton);
		}
		bubble.append(actions);
		row.append(bubble);
		return row;
	}

	function appendFormattedContent(element, content) {
		const tokens = content.split(/(#[\p{L}\p{N}_]+|@[\p{L}\p{N}_.-]+)/gu);
		tokens.forEach((token) => {
			if (token.startsWith("#")) {
				const link = makeElement("a", "inline-tag", token);
				link.href = "#feed";
				link.dataset.searchTerm = token;
				element.append(link);
			} else if (token.startsWith("@")) {
				const link = makeElement("button", "inline-mention", token);
				link.type = "button";
				link.dataset.action = "search-user";
				link.dataset.searchTerm = token.slice(1);
				element.append(link);
			} else element.append(document.createTextNode(token));
		});
	}

	function makePoll(post) {
		if (!post.pollOptions.length) return null;
		const poll = makeElement("div", "poll-options");
		const total = post.pollVotes.length;
		const ownVote = post.pollVotes.find((vote) => vote.user_id === userId);
		post.pollOptions.forEach((option, index) => {
			const votes = post.pollVotes.filter((vote) => vote.option_index === index).length;
			const button = makeElement("button", "poll-option-button");
			button.type = "button";
			button.dataset.action = "vote-poll";
			button.dataset.postId = post.id;
			button.dataset.optionIndex = String(index);
			button.disabled = Boolean(ownVote);
			const bar = makeElement("span");
			bar.style.width = `${total ? Math.round(votes / total * 100) : 0}%`;
			button.append(bar, makeElement("strong", "", option), makeElement("small", "", `${votes} · ${total ? Math.round(votes / total * 100) : 0}%`));
			poll.append(button);
		});
		poll.append(makeElement("small", "feature-meta", `${total} vote${total === 1 ? "" : "s"}`));
		return poll;
	}

	function makePostCard(post) {
		const article = makeElement("article", "post-card");
		const header = makeElement("div", "post-header");
		header.append(makeProfileImage(post.avatarUrl, post.name));
		const author = makeElement("div", "post-author");
		const authorLink = post.userId ? makeElement("button", "author-link", post.name) : makeElement("strong", "", post.name);
		if (post.userId) {
			authorLink.type = "button";
			authorLink.dataset.action = "view-user";
			authorLink.dataset.userId = post.userId;
		}
		author.append(
			authorLink,
			makeElement("small", "", `@${post.handle} · ${formatTime(post.createdAt)}`)
		);
		const meta = makeElement("div", "post-meta");
		meta.append(makeElement("span", "category-tag", post.category));
		header.append(author, meta);

		const content = makeElement("p", "post-content");
		appendFormattedContent(content, post.content);
		const actions = makeElement("div", "post-actions");
		const likeButton = makeElement("button", `post-action${post.liked ? " liked" : ""}`);
		likeButton.type = "button";
		likeButton.dataset.action = "like";
		likeButton.dataset.postId = post.id;
		likeButton.setAttribute("aria-pressed", String(post.liked));
		likeButton.append(
			document.createTextNode(post.liked ? "♥" : "♡"),
			document.createTextNode(` ${post.likes.length} ${post.likes.length === 1 ? "heart" : "hearts"}`)
		);

		const commentButton = makeElement("button", "post-action");
		commentButton.type = "button";
		commentButton.dataset.action = "comment";
		commentButton.dataset.postId = post.id;
		commentButton.append(
			document.createTextNode("▱"),
			document.createTextNode(` ${post.comments.length} ${post.comments.length === 1 ? "reply" : "replies"}`)
		);

		const saveButton = makeElement("button", `post-action${post.saved ? " saved" : ""}`);
		saveButton.type = "button";
		saveButton.dataset.action = "save";
		saveButton.dataset.postId = post.id;
		saveButton.setAttribute("aria-pressed", String(post.saved));
		saveButton.append(
			document.createTextNode(post.saved ? "▣" : "□"),
			document.createTextNode(post.saved ? " Saved" : " Save")
		);
		actions.append(likeButton, commentButton, saveButton);
		if (post.userId === userId) {
			const editButton = makeElement("button", "post-action", "Edit");
			editButton.type = "button";
			editButton.dataset.action = "edit-post";
			editButton.dataset.postId = post.id;
			const deleteButton = makeElement("button", "post-action danger-action", "Delete");
			deleteButton.type = "button";
			deleteButton.dataset.action = "delete-post";
			deleteButton.dataset.postId = post.id;
			actions.append(editButton, deleteButton);
		} else {
			const reportButton = makeElement("button", "post-action", "Report");
			reportButton.type = "button";
			reportButton.dataset.action = "report-post";
			reportButton.dataset.postId = post.id;
			actions.append(reportButton);
		}

		const commentList = makeElement("div", "comment-list");
		function appendCommentTree(parentId, depth = 0) {
			if (depth > 4) return;
			post.comments.filter((comment) => (comment.parentId || null) === parentId).forEach((comment) => {
				comment.postId = post.id;
				comment.canMarkHelpful = post.userId === userId && post.category === "Questions";
				const node = makeComment(comment);
				if (depth > 0) node.classList.add("nested-comment");
				commentList.append(node);
				appendCommentTree(comment.id, depth + 1);
			});
		}
		appendCommentTree(null);

		const commentForm = makeElement("form", "comment-form");
		commentForm.dataset.postId = post.id;
		const input = document.createElement("input");
		input.name = "comment";
		input.type = "text";
		input.maxLength = 240;
		input.placeholder = "Leave a kind note...";
		input.setAttribute("aria-label", "Write a comment");
		input.required = true;
		const imagePicker = makeElement("label", "comment-image-picker", "＋ Photo");
		const imageInput = document.createElement("input");
		imageInput.type = "file";
		imageInput.name = "image";
		imageInput.accept = "image/jpeg,image/png,image/webp,image/gif";
		imageInput.setAttribute("aria-label", "Attach a photo to your comment");
		imagePicker.append(imageInput);
		const imagePreview = makeElement("img", "comment-image-preview");
		imagePreview.alt = "Selected comment photo preview";
		imagePreview.hidden = true;
		const clearImage = makeElement("button", "comment-image-clear", "Remove photo");
		clearImage.type = "button";
		clearImage.dataset.action = "clear-comment-image";
		clearImage.hidden = true;
		const imageStatus = makeElement("span", "comment-form-status");
		imageStatus.setAttribute("role", "status");
		imageStatus.setAttribute("aria-live", "polite");
		const parentId = document.createElement("input");
		parentId.type = "hidden";
		parentId.name = "parentId";
		const submit = makeElement("button", "", "Reply");
		submit.type = "submit";
		commentForm.append(parentId, input, imagePicker, imagePreview, clearImage, submit, imageStatus);
		article.append(header, content);
		const imageUrl = safeImageUrl(post.imageUrl);
		if (imageUrl) {
			const image = makeElement("img", "content-image");
			image.src = imageUrl;
			image.alt = "Image attached to this post";
			image.loading = "lazy";
			article.append(image);
		}
		if (post.linkUrl) {
			const link = makeElement("a", "link-preview", post.linkUrl);
			link.href = post.linkUrl;
			link.target = "_blank";
			link.rel = "noopener noreferrer";
			article.append(link);
		}
		const poll = makePoll(post);
		article.append(...(poll ? [poll] : []), actions, commentList, commentForm);
		return article;
	}

	function renderFeed() {
		const query = searchInput.value.trim().toLowerCase();
		const feedMode = document.getElementById("sort-select").value;
		const sortMode = document.getElementById("order-select").value;
		const visiblePosts = posts
			.filter((post) => (activeFilter === "all" || post.category === activeFilter)
				&& `${post.name} ${post.handle} ${post.category} ${post.content} ${post.comments.map((comment) => comment.text).join(" ")}`.toLowerCase().includes(query))
			.filter((post) => feedMode !== "following" || followingIds.has(post.userId) || post.userId === userId)
			.filter((post) => feedMode !== "saved" || post.saved)
			.sort((first, second) => feedMode === "trending"
				? (second.likes.length + second.comments.length * 2) - (first.likes.length + first.comments.length * 2)
					|| new Date(second.createdAt) - new Date(first.createdAt)
				: sortMode === "liked"
					? second.likes.length - first.likes.length || new Date(second.createdAt) - new Date(first.createdAt)
					: new Date(second.createdAt) - new Date(first.createdAt));
		releaseCommentPreviews(feed);
		feed.replaceChildren(...visiblePosts.map(makePostCard));
		const empty = document.getElementById("empty-feed");
		empty.hidden = visiblePosts.length > 0;
		empty.textContent = query ? "No posts match your search."
			: feedMode === "following" ? "No posts from people you follow yet."
				: feedMode === "saved" ? "You haven’t bookmarked any posts yet."
					: "No updates yet. Be the first to post.";
	}

	async function loadPosts() {
		if (!userId || !supabaseClient) return;
		try {
			const { data, error } = await supabaseClient
				.from("posts")
				.select("id,user_id,guest_id,display_name,category,content,image_url,link_url,poll_options,created_at,profiles!posts_user_id_fkey(display_name,avatar_url),comments(id,user_id,guest_id,parent_comment_id,is_helpful,display_name,content,image_url,created_at,profiles!comments_user_id_fkey(display_name,avatar_url)),likes(user_id,guest_id),poll_votes(user_id,option_index)")
				.order("created_at", { ascending: false })
				.range(0, 99);
			if (error) throw error;
			posts = data.map(normalizePost);
			setFeedMessage("");
			renderFeed();
		} catch (error) {
			const missingPhotoColumn = error?.code === "42703" && /image_url/i.test(error.message || "");
			if (missingPhotoColumn) console.error("RTT comment-photo schema is missing comments.image_url.", error);
			const message = missingPhotoColumn
				? "The connected Supabase database is missing comments.image_url. Run the updated supabase-schema.sql in the Supabase SQL Editor, then reload RTT."
				: errorMessage(error, "Please try again.");
			setFeedMessage(`Could not load the RTT feed: ${message}`);
			feed.replaceChildren();
			document.getElementById("empty-feed").hidden = false;
			document.getElementById("empty-feed").textContent = missingPhotoColumn
				? "Comment photo support is not set up in Supabase yet. Run the updated supabase-schema.sql, then reload."
				: "Could not load the RTT feed. Check your connection and try again.";
		}
	}

	async function loadSocialContext() {
		try {
			const [{ data: following, error: followsError }, { data: bookmarks, error: bookmarksError }] = await Promise.all([
				supabaseClient.from("follows").select("following_id").eq("follower_id", userId),
				supabaseClient.from("post_bookmarks").select("post_id").eq("user_id", userId)
			]);
			if (followsError) throw followsError;
			if (bookmarksError) throw bookmarksError;
			followingIds = new Set(following.map((row) => row.following_id));
			bookmarkIds = new Set(bookmarks.map((row) => row.post_id));
			renderFeed();
			await updateActivityCounts();
		} catch (error) {
			setFeedMessage(`Could not load your RTT settings: ${errorMessage(error, "Please try again.")}`);
		}
	}

	async function updateActivityCounts() {
		if (!userId || !supabaseClient) return;
		try {
			const mutedIds = getMutedConversationIds();
			let messageAlertsQuery = supabaseClient.from("notifications").select("id", { count: "exact", head: true })
				.is("read_at", null).eq("kind", "message");
			let unreadMessagesQuery = supabaseClient.from("messages").select("id", { count: "exact", head: true })
				.is("read_at", null).neq("sender_id", userId);
			if (mutedIds.length) {
				const filter = `(${mutedIds.join(",")})`;
				messageAlertsQuery = messageAlertsQuery.not("conversation_id", "in", filter);
				unreadMessagesQuery = unreadMessagesQuery.not("conversation_id", "in", filter);
			}
			const [{ count: otherNotifications, error: notificationError }, { count: messageAlerts, error: alertsError }, { count: messages, error: messageError }] = await Promise.all([
				supabaseClient.from("notifications").select("id", { count: "exact", head: true }).is("read_at", null).neq("kind", "message"),
				messageAlertsQuery,
				unreadMessagesQuery
			]);
			if (notificationError) throw notificationError;
			if (alertsError) throw alertsError;
			if (messageError) throw messageError;
			setBadge("notification-count", (otherNotifications || 0) + (messageAlerts || 0));
			setBadge("message-count", messages);
		} catch (error) {
			console.error("Could not update notification counts", error);
		}
	}

	function setBadge(id, count) {
		const badge = document.getElementById(id);
		badge.hidden = !count;
		badge.textContent = count > 99 ? "99+" : String(count || "");
	}

	function setFilter(filter, button) {
		activeView = "feed";
		document.getElementById("feature-view").hidden = true;
		document.querySelector(".feed-column").hidden = false;
		document.querySelector(".right-column").hidden = false;
		activeFilter = filter;
		filterButtons.forEach((item) => {
			const active = item === button;
			item.classList.toggle("active", active);
			item.setAttribute("aria-pressed", String(active));
		});
		document.getElementById("feed-title").textContent = filter === "all"
			? "RTT Home"
			: filter === "Study" ? "Study"
				: filter === "Life Update" ? "Life Update"
					: filter === "Wins" ? "Wins" : "Questions";
		renderFeed();
	}

	function addFeatureHeading(title, subtitle, eyebrow = "RTT COMMUNITY") {
		const heading = makeElement("div", "feature-heading");
		const copy = document.createElement("div");
		copy.append(makeElement("p", "eyebrow", eyebrow), makeElement("h2", "", title));
		if (subtitle) copy.append(makeElement("p", "", subtitle));
		heading.append(copy);
		featureView.append(heading);
	}

	function addFeatureStatus(container, message, success = false) {
		const status = makeElement("p", `feature-status${success ? " success" : ""}`, message);
		container.append(status);
		return status;
	}

	function addField(form, labelText, name, type = "text", value = "", options = {}) {
		const label = makeElement("label", "", labelText);
		let input;
		if (type === "textarea") {
			input = document.createElement("textarea");
		} else if (type === "select") {
			input = document.createElement("select");
			options.choices.forEach((choice) => {
				const option = makeElement("option", "", choice);
				option.value = choice;
				input.append(option);
			});
		} else {
			input = document.createElement("input");
			input.type = type;
		}
		input.name = name;
		input.value = value || "";
		if (options.required) input.required = true;
		if (options.maxLength) input.maxLength = options.maxLength;
		if (options.placeholder) input.placeholder = options.placeholder;
		if (options.multiple) input.multiple = true;
		if (options.accept) input.accept = options.accept;
		if (type === "file") input.value = "";
		label.append(input);
		form.append(label);
		return input;
	}

	function makeFormButton(label, className = "post-button") {
		const button = makeElement("button", className, label);
		button.type = "submit";
		return button;
	}

	async function uploadImage(file, folder) {
		const validTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
		if (!validTypes.includes(file.type)) throw new Error("Choose a JPG, PNG, WebP, or GIF image.");
		if (file.size > 5 * 1024 * 1024) throw new Error("Images must be 5 MB or smaller.");
		if (!userId || !supabaseClient?.auth) throw new Error("Sign in again before uploading a photo.");
		const { data: sessionData, error: sessionError } = await supabaseClient.auth.getSession();
		if (sessionError) throw sessionError;
		if (!sessionData.session?.user?.id || sessionData.session.user.id !== userId) {
			throw new Error("Your sign-in session expired. Log in again before uploading a photo.");
		}
		const extension = file.type === "image/jpeg" ? "jpg" : file.type.split("/")[1];
		const fileId = typeof crypto.randomUUID === "function"
			? crypto.randomUUID()
			: Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
		const path = `${userId}/${folder}/${fileId}.${extension}`;
		const { data, error } = await supabaseClient.storage.from("rtt-media").upload(path, file, {
			cacheControl: "3600",
			upsert: false,
			contentType: file.type
		});
		if (error) {
			if (/bucket.*not found|bucket does not exist/i.test(error.message || "")) {
				throw new Error("The RTT media bucket is missing. Run the updated supabase-schema.sql in the Supabase SQL Editor.");
			}
			if (/row-level security policy|new row violates row-level security/i.test(error.message || "")) {
				throw new Error("Supabase blocked the photo upload. In the SQL Editor, run the storage bucket and upload-policy section from supabase-schema.sql, then try again.");
			}
			throw error;
		}
		if (!data?.path) throw new Error("Supabase accepted the upload but did not return its storage path. Please try again.");
		const { data: publicUrlData } = supabaseClient.storage.from("rtt-media").getPublicUrl(data.path);
		if (!publicUrlData?.publicUrl) throw new Error("The photo uploaded, but Supabase did not return a public image URL.");
		return publicUrlData.publicUrl;
	}

	function makeProfileImage(url, name, className = "avatar") {
		const avatar = makeElement("div", className);
		avatar.setAttribute("aria-hidden", "true");
		const imageUrl = safeImageUrl(url);
		if (imageUrl) {
			const image = makeElement("img");
			image.src = imageUrl;
			image.alt = "";
			avatar.append(image);
		} else {
			avatar.textContent = Array.from((name || "S").trim())[0]?.toUpperCase() || "S";
		}
		return avatar;
	}

	function makePresenceIndicator(profileId) {
		const indicator = makeElement("span", `presence-indicator${onlineUsers.has(profileId) ? " online" : ""}`);
		indicator.dataset.presenceUser = profileId;
		indicator.setAttribute("aria-label", onlineUsers.has(profileId) ? "Online" : "Offline");
		return indicator;
	}

	function setProfileImages(profile) {
		const avatar = document.getElementById("signed-in-avatar");
		avatar.replaceChildren();
		const avatarUrl = safeImageUrl(profile.avatar_url);
		if (avatarUrl) {
			const image = makeElement("img");
			image.src = avatarUrl;
			image.alt = "";
			avatar.append(image);
		} else avatar.textContent = Array.from(displayName.trim())[0]?.toUpperCase() || "S";
	}

	async function showView(view, parameter = "") {
		releaseCommentPreviews(featureView);
		activeView = view;
		featureView.classList.remove("messages-page");
		document.querySelector(".left-column").hidden = view !== "feed";
		document.querySelector(".feed-column").hidden = view !== "feed";
		document.querySelector(".right-column").hidden = view !== "feed";
		featureView.hidden = view === "feed";
		document.querySelectorAll("[data-view]").forEach((button) => {
			button.classList.toggle("active", button.dataset.view === view);
		});
		if (view === "feed") {
			featureView.replaceChildren();
			renderFeed();
			return;
		}
		featureView.replaceChildren(makeElement("div", "skeleton"));
		try {
			if (view === "profile") await renderProfile(userId);
			else if (view === "user-profile") await renderProfile(parameter);
			else if (view === "groups") await renderGroups();
			else if (view === "group-detail") await renderGroupDetail(parameter);
			else if (view === "events") await renderEvents();
			else if (view === "messages") await renderMessages(parameter);
			else if (view === "notifications") await renderNotifications();
			else if (view === "leaderboard") await renderLeaderboard();
			else if (view === "settings") await renderSettings();
			else if (view === "search") await renderSearch(parameter);
			else if (view === "admin") await renderAdmin();
			else await showView("feed");
		} catch (error) {
			featureView.replaceChildren();
			addFeatureHeading("Could not load this page", "Please check your connection and try again.");
			addFeatureStatus(featureView, errorMessage(error, "Could not load community data."));
			const retry = makeElement("button", "outline-button", "Try again");
			retry.type = "button";
			retry.dataset.action = "retry-view";
			retry.dataset.view = view;
			featureView.append(retry);
		}
	}

	async function renderProfile(profileId) {
		const { data: profile, error } = await supabaseClient
			.from("profiles")
			.select("id,display_name,username,avatar_url,cover_url,bio,courses,year_level,points,is_admin,discoverable,notifications_enabled,settings")
			.eq("id", profileId)
			.maybeSingle();
		if (error) throw error;
		if (!profile) throw new Error("That student profile could not be found.");
		if (profileId === userId) currentProfile = profile;
		featureView.replaceChildren();
		addFeatureHeading(profileId === userId ? "My profile" : profile.display_name, "Your campus identity, courses, and contributions.");
		const card = makeElement("article", "feature-card profile-card");
		const cover = makeElement("div", "profile-cover");
		const coverUrl = safeImageUrl(profile.cover_url);
		if (coverUrl) {
			const image = makeElement("img");
			image.src = coverUrl;
			image.alt = "Profile cover";
			cover.append(image);
		}
		card.append(cover);
		const summary = makeElement("div", "profile-summary");
		const details = makeElement("div", "profile-details");
		details.append(makeProfileImage(profile.avatar_url, profile.display_name, "avatar profile-avatar"));
		const profileSettings = profile.settings || {};
		const profileMeta = `@${profile.username}${profileSettings.show_year_level === false || !profile.year_level ? "" : ` · ${profile.year_level}`}`;
		details.append(
			makeElement("h3", "", profile.display_name),
			makeElement("p", "feature-meta", profileMeta),
			makeElement("p", "", profile.bio || "No bio yet.")
		);
		const stats = makeElement("div", "profile-stats");
		const [{ count: followers }, { count: following }] = await Promise.all([
			supabaseClient.from("follows").select("follower_id", { count: "exact", head: true }).eq("following_id", profileId),
			supabaseClient.from("follows").select("following_id", { count: "exact", head: true }).eq("follower_id", profileId)
		]);
		stats.append(makeElement("span", "", `${followers || 0} followers`), makeElement("span", "", `${following || 0} following`), makeElement("span", "", `${profile.points} pts`));
		summary.append(details, stats);
		card.append(summary);
		const courseLineText = profileSettings.show_courses === false && profileId !== userId
			? "Course details are private."
			: profileSettings.show_courses === false ? "Courses hidden from your profile."
				: profile.courses?.length ? `Courses: ${profile.courses.join(", ")}` : "No courses listed.";
		const courseLine = makeElement("p", "feature-meta", courseLineText);
		card.append(courseLine);
		if (profileId !== userId) {
			const follow = makeElement("button", "outline-button", followingIds.has(profileId) ? "Following" : "Follow");
			follow.type = "button";
			follow.dataset.action = "toggle-follow";
			follow.dataset.userId = profileId;
			card.append(follow);
			const message = makeElement("button", "outline-button", "Message");
			message.type = "button";
			message.dataset.action = "start-chat";
			message.dataset.userId = profileId;
			card.append(message);
		} else {
			const edit = makeElement("button", "outline-button", "Edit profile");
			edit.type = "button";
			edit.dataset.action = "edit-profile";
			card.append(edit);
		}
		featureView.append(card);
		const { data: userPosts, error: postsError } = await supabaseClient
			.from("posts")
			.select("id,user_id,guest_id,display_name,category,content,image_url,link_url,poll_options,created_at,profiles!posts_user_id_fkey(display_name,avatar_url),comments(id,user_id,guest_id,parent_comment_id,is_helpful,display_name,content,image_url,created_at,profiles!comments_user_id_fkey(display_name,avatar_url)),likes(user_id,guest_id),poll_votes(user_id,option_index)")
			.eq("user_id", profileId)
			.order("created_at", { ascending: false })
			.limit(20);
		if (postsError) throw postsError;
		featureView.append(makeElement("h3", "profile-post-heading", "Recent posts"));
		userPosts.forEach((row) => featureView.append(makePostCard(normalizePost(row))));
		if (!userPosts.length) featureView.append(makeElement("p", "empty-feed", "No posts to show yet."));
	}

	function renderProfileEditor() {
		const profile = currentProfile;
		featureView.replaceChildren();
		addFeatureHeading("Edit profile", "Keep your student profile current.");
		const form = makeElement("form", "feature-form");
		form.dataset.featureForm = "profile";
		addField(form, "Display name", "display_name", "text", profile.display_name, { required: true, maxLength: 50 });
		addField(form, "Username", "username", "text", profile.username, { required: true, maxLength: 24, placeholder: "letters, numbers, and underscores" });
		addField(form, "Bio", "bio", "textarea", profile.bio, { maxLength: 280, placeholder: "A little about you" });
		addField(form, "Courses (comma-separated)", "courses", "text", (profile.courses || []).join(", "), { maxLength: 240, placeholder: "Computer science, Design..." });
		addField(form, "Year level", "year_level", "select", profile.year_level, { choices: ["", "1st year", "2nd year", "3rd year", "4th year", "Graduate", "Other"] });
		addField(form, "Profile picture (JPG, PNG, WebP, GIF · max 5 MB)", "avatar", "file", "", { accept: "image/jpeg,image/png,image/webp,image/gif" });
		addField(form, "Cover photo (JPG, PNG, WebP, GIF · max 5 MB)", "cover", "file", "", { accept: "image/jpeg,image/png,image/webp,image/gif" });
		form.append(makeFormButton("Save profile"));
		addFeatureStatus(form, "");
		featureView.append(form);
	}

	async function renderGroups() {
		featureView.replaceChildren();
		addFeatureHeading("Study groups", "Find classmates, share ideas, and work through tough topics together.");
		const form = makeElement("form", "feature-form");
		form.dataset.featureForm = "create-group";
		form.append(makeElement("h3", "", "Start a study group"));
		addField(form, "Group name", "name", "text", "", { required: true, maxLength: 80, placeholder: "e.g. Algorithms study crew" });
		addField(form, "Course", "course", "text", "", { maxLength: 80, placeholder: "Course or subject" });
		addField(form, "Description", "description", "textarea", "", { maxLength: 500, placeholder: "What are you working on?" });
		form.append(makeFormButton("Create group"));
		addFeatureStatus(form, "");
		featureView.append(form);
		const { data: groups, error } = await supabaseClient
			.from("study_groups")
			.select("id,name,description,course,owner_id,created_at,study_group_members(user_id)")
			.order("created_at", { ascending: false })
			.limit(50);
		if (error) throw error;
		const list = makeElement("div", "feature-grid");
		for (const group of groups) {
			const card = makeElement("article", "feature-card");
			card.append(
				makeElement("h3", "", group.name),
				makeElement("p", "feature-meta", `${group.course || "Open study group"} · ${group.study_group_members.length} members`),
				makeElement("p", "", group.description)
			);
			const joined = group.study_group_members.some((member) => member.user_id === userId);
			const join = makeElement("button", "outline-button", joined ? "Open discussion" : "Join group");
			join.type = "button";
			join.dataset.action = joined ? "open-group" : "join-group";
			join.dataset.groupId = group.id;
			card.append(join);
			if (joined && group.owner_id !== userId) {
				const leave = makeElement("button", "outline-button", "Leave");
				leave.type = "button";
				leave.dataset.action = "leave-group";
				leave.dataset.groupId = group.id;
				card.append(leave);
			}
			list.append(card);
		}
		featureView.append(list);
		if (!groups.length) list.append(makeElement("p", "empty-feed", "No study groups yet. Start one for your course."));
	}

	async function renderGroupDetail(groupId) {
		const { data: group, error } = await supabaseClient.from("study_groups").select("id,name,description,course").eq("id", groupId).single();
		if (error) throw error;
		featureView.replaceChildren();
		addFeatureHeading(group.name, `${group.course || "Study group"} · ${group.description}`, "GROUP DISCUSSION");
		const form = makeElement("form", "feature-form");
		form.dataset.featureForm = "group-message";
		form.dataset.groupId = groupId;
		addField(form, "Share a note with the group", "content", "textarea", "", { required: true, maxLength: 2000 });
		form.append(makeFormButton("Send to group"));
		addFeatureStatus(form, "");
		featureView.append(form);
		const { data: messages, error: messageError } = await supabaseClient.from("study_group_messages")
			.select("id,user_id,content,created_at,profiles!study_group_messages_user_id_fkey(display_name)")
			.eq("group_id", groupId).order("created_at", { ascending: true }).limit(100);
		if (messageError) throw messageError;
		messages.forEach((message) => {
			const card = makeElement("article", "feature-card");
			card.append(makeElement("strong", "", message.profiles?.display_name || "Student"), makeElement("p", "", message.content), makeElement("small", "feature-meta", formatTime(message.created_at)));
			featureView.append(card);
		});
		if (!messages.length) featureView.append(makeElement("p", "empty-feed", "Start the group discussion with a note."));
		const back = makeElement("button", "outline-button", "All study groups");
		back.type = "button";
		back.dataset.action = "retry-view";
		back.dataset.view = "groups";
		featureView.prepend(back);
	}

	async function renderEvents() {
		featureView.replaceChildren();
		addFeatureHeading("School events", "Activities, organization meetings, deadlines, and study sessions.");
		const form = makeElement("form", "feature-form");
		form.dataset.featureForm = "create-event";
		form.append(makeElement("h3", "", "Post an event"));
		addField(form, "Event title", "title", "text", "", { required: true, maxLength: 120 });
		addField(form, "Description", "description", "textarea", "", { maxLength: 1000 });
		addField(form, "Location", "location", "text", "", { maxLength: 160 });
		addField(form, "Date and time", "starts_at", "datetime-local", "", { required: true });
		form.append(makeFormButton("Create event"));
		addFeatureStatus(form, "");
		featureView.append(form);
		const { data: events, error } = await supabaseClient.from("campus_events")
			.select("id,title,description,location,starts_at,organizer_id,event_attendees(user_id)")
			.gte("starts_at", new Date(Date.now() - 86400000).toISOString())
			.order("starts_at", { ascending: true }).limit(50);
		if (error) throw error;
		events.forEach((event) => {
			const card = makeElement("article", "feature-card");
			const date = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(event.starts_at));
			card.append(
				makeElement("h3", "", event.title),
				makeElement("p", "feature-meta", `${date} · ${event.location || "Location TBA"} · ${event.event_attendees.length} attending`),
				makeElement("p", "", event.description)
			);
			const attending = event.event_attendees.some((attendee) => attendee.user_id === userId);
			const rsvp = makeElement("button", "outline-button", attending ? "Cancel RSVP" : "I’m going");
			rsvp.type = "button";
			rsvp.dataset.action = "rsvp-event";
			rsvp.dataset.eventId = event.id;
			rsvp.dataset.attending = String(attending);
			card.append(rsvp);
			if (event.organizer_id === userId || currentProfile.is_admin) {
				const remove = makeElement("button", "outline-button danger", "Delete event");
				remove.type = "button";
				remove.dataset.action = "delete-event";
				remove.dataset.eventId = event.id;
				card.append(remove);
			}
			featureView.append(card);
		});
		if (!events.length) featureView.append(makeElement("p", "empty-feed", "No upcoming events. Add a school event or deadline."));
	}

	async function searchDirectory(query, mode = "all") {
		await showView("search", `${mode}|${query}`);
	}

	async function renderSearch(value) {
		const [mode, rawQuery] = value.includes("|") ? value.split("|", 2) : ["all", value];
		const query = cleanSearchTerm(rawQuery);
		featureView.replaceChildren();
		addFeatureHeading("Search RTT", query ? `Results for “${query}”` : "Search posts, people, groups, and hashtags.");
		const form = makeElement("form", "feature-form");
		form.dataset.featureForm = "search";
		const input = addField(form, "Search", "query", "search", query, { placeholder: "Try a name, course, or #hashtag" });
		form.append(makeFormButton("Search"));
		addFeatureStatus(form, "");
		featureView.append(form);
		input.focus();
		if (!query) return;
		const pattern = `%${query}%`;
		if (mode === "all" || mode === "users") {
			const { data: people, error } = await supabaseClient.from("profiles")
				.select("id,display_name,username,avatar_url,bio,year_level,settings")
				.or(`display_name.ilike.${pattern},username.ilike.${pattern}`)
				.limit(20);
			if (error) throw error;
			featureView.append(makeElement("h3", "profile-post-heading", "Students"));
			people.forEach((person) => {
				const card = makeElement("article", "feature-card feature-row");
				card.append(makeProfileImage(person.avatar_url, person.display_name));
				const info = makeElement("div", "feature-grow");
				const personSettings = person.settings || {};
				const yearLabel = personSettings.show_year_level === false || !person.year_level ? "" : ` · ${person.year_level}`;
				info.append(makeElement("strong", "", person.display_name), makeElement("p", "feature-meta", `@${person.username}${yearLabel}`));
				card.append(info, makePresenceIndicator(person.id));
				const view = makeElement("button", "outline-button", "View");
				view.type = "button";
				view.dataset.action = "view-user";
				view.dataset.userId = person.id;
				card.append(view);
				featureView.append(card);
			});
		}
		if (mode === "all" || mode === "posts") {
			if (mode === "all") featureView.append(makeElement("h3", "profile-post-heading", "Posts and hashtags"));
			const { data: rows, error } = await supabaseClient.from("posts")
				.select("id,user_id,guest_id,display_name,category,content,image_url,link_url,poll_options,created_at,profiles!posts_user_id_fkey(display_name,avatar_url),comments(id,user_id,guest_id,parent_comment_id,is_helpful,display_name,content,image_url,created_at,profiles!comments_user_id_fkey(display_name,avatar_url)),likes(user_id,guest_id),poll_votes(user_id,option_index)")
				.ilike("content", pattern).order("created_at", { ascending: false }).limit(30);
			if (error) throw error;
			rows.forEach((row) => featureView.append(makePostCard(normalizePost(row))));
		}
		if (mode === "all" || mode === "groups") {
			const { data: groups, error } = await supabaseClient.from("study_groups")
				.select("id,name,description,course").or(`name.ilike.${pattern},course.ilike.${pattern}`).limit(20);
			if (error) throw error;
			if (mode === "all") featureView.append(makeElement("h3", "profile-post-heading", "Study groups"));
			groups.forEach((group) => {
				const card = makeElement("article", "feature-card");
				card.append(makeElement("h3", "", group.name), makeElement("p", "feature-meta", group.course), makeElement("p", "", group.description));
				featureView.append(card);
			});
		}
	}

	async function renderNotifications() {
		featureView.replaceChildren();
		addFeatureHeading("Notifications", "Recent activity from people in your network.");
		const markAll = makeElement("button", "outline-button", "Mark all as read");
		markAll.type = "button";
		markAll.dataset.action = "mark-all-read";
		featureView.append(markAll);
		let notificationsQuery = supabaseClient.from("notifications")
			.select("id,actor_id,kind,post_id,comment_id,conversation_id,read_at,created_at,profiles!notifications_actor_id_fkey(display_name)")
			.order("created_at", { ascending: false }).limit(50);
		const mutedIds = getMutedConversationIds();
		if (mutedIds.length) notificationsQuery = notificationsQuery.or(`kind.neq.message,conversation_id.not.in.(${mutedIds.join(",")})`);
		const { data: notifications, error } = await notificationsQuery;
		if (error) throw error;
		notifications.forEach((item) => {
			const name = item.profiles?.display_name || "A member";
			const activity = {
				like: "liked your post",
				comment: "commented on your post",
				reply: "replied to your comment",
				follow: "started following you",
				message: "sent you a message"
			}[item.kind] || "interacted with you";
			const card = makeElement("article", `feature-card${item.read_at ? "" : " notification-unread"}`);
			card.append(makeElement("p", "", `${name} ${activity}`), makeElement("small", "feature-meta", formatTime(item.created_at)));
			const actions = makeElement("div", "feature-actions");
			if (!item.read_at) {
				const read = makeElement("button", "outline-button", "Mark read");
				read.type = "button";
				read.dataset.action = "read-notification";
				read.dataset.notificationId = item.id;
				actions.append(read);
			}
			if (item.kind === "message" && item.conversation_id) {
				const message = makeElement("button", "outline-button", "Open message");
				message.type = "button";
				message.dataset.action = "open-conversation";
				message.dataset.conversationId = item.conversation_id;
				actions.append(message);
			}
			if (item.post_id) {
				const post = makeElement("button", "outline-button", "View post");
				post.type = "button";
				post.dataset.action = "view-post";
				post.dataset.postId = item.post_id;
				actions.append(post);
			}
			card.append(actions);
			featureView.append(card);
		});
		if (!notifications.length) featureView.append(makeElement("p", "empty-feed", "You’re all caught up."));
		await updateActivityCounts();
	}

	function appendMessageTabs(container) {
		const tabs = makeElement("div", "message-filter-row");
		[["all", "All messages"], ["unread", "Unread"], ["online", "Online"], ["archived", "Archived"]].forEach(([filter, label]) => {
			const button = makeElement("button", `message-filter${messageFilter === filter ? " active" : ""}`, label);
			button.type = "button";
			button.dataset.action = "message-filter";
			button.dataset.filter = filter;
			button.setAttribute("aria-pressed", String(messageFilter === filter));
			tabs.append(button);
		});
		container.append(tabs);
	}

	async function renderMessages(selectedConversationId = "", page = 0) {
		activeConversationId = selectedConversationId;
		activeMessagePage = page;
		featureView.classList.add("messages-page");
		featureView.replaceChildren();
		addFeatureHeading("Messages", "Private conversations with RTT students. Online status is based on active RTT sessions.");
		const workspace = makeElement("div", "message-workspace");
		const sidebar = makeElement("aside", "message-sidebar");
		const search = makeElement("form", "message-search-form");
		search.dataset.featureForm = "message-search";
		const searchInput = addField(search, "Search people or conversations", "query", "search", messageQuery, { placeholder: "Name, username, or message" });
		searchInput.autocomplete = "off";
		const findButton = makeFormButton("Find student", "outline-button");
		search.append(findButton);
		const searchResults = makeElement("div", "message-search-results");
		searchResults.id = "message-search-results";
		search.append(searchResults);
		addFeatureStatus(search, "");
		sidebar.append(search);
		appendMessageTabs(sidebar);
		sidebar.append(makeElement("p", "message-local-note", "Mute and archive preferences are stored on this device."));
		const { data: conversations, error } = await supabaseClient.from("conversations")
			.select("id,member_a,member_b,created_at,messages(id,sender_id,content,read_at,created_at)")
			.order("created_at", { ascending: false })
			.order("created_at", { ascending: false, foreignTable: "messages" })
			.limit(1, { foreignTable: "messages" }).limit(50);
		if (error) throw error;
		const otherIds = [...new Set(conversations.map((item) => item.member_a === userId ? item.member_b : item.member_a))];
		const { data: people, error: peopleError } = otherIds.length
			? await supabaseClient.from("profiles").select("id,display_name,username,avatar_url").in("id", otherIds)
			: { data: [], error: null };
		if (peopleError) throw peopleError;
		const peopleById = new Map(people.map((person) => [person.id, person]));
		const unreadByConversation = new Map();
		if (conversations.length) {
			const { data: unreadMessages, error: unreadError } = await supabaseClient.from("messages")
				.select("conversation_id").in("conversation_id", conversations.map((item) => item.id))
				.neq("sender_id", userId).is("read_at", null).limit(1000);
			if (unreadError) throw unreadError;
			unreadMessages.forEach((message) => {
				unreadByConversation.set(message.conversation_id, (unreadByConversation.get(message.conversation_id) || 0) + 1);
			});
		}
		const archived = readPreferenceSet("rtt-archived-conversations");
		const conversationRows = conversations.map((conversation) => {
			const otherId = conversation.member_a === userId ? conversation.member_b : conversation.member_a;
			const person = peopleById.get(otherId);
			const lastMessage = conversation.messages?.[0];
			const unread = unreadByConversation.get(conversation.id) || 0;
			return { conversation, person, otherId, lastMessage, unread };
		}).filter((row) => row.person);
		const list = makeElement("div", "message-conversation-list");
		list.id = "message-conversation-list";
		const renderList = () => {
			const query = messageQuery.toLocaleLowerCase();
			const muted = readPreferenceSet("rtt-muted-conversations");
			const rows = conversationRows.filter((row) => {
				const isArchived = archived.has(row.conversation.id);
				if (messageFilter === "archived" ? !isArchived : isArchived) return false;
				if (messageFilter === "unread" && !row.unread) return false;
				if (messageFilter === "online" && !onlineUsers.has(row.otherId)) return false;
				return !query || `${row.person.display_name} ${row.person.username} ${row.lastMessage?.content || ""}`.toLocaleLowerCase().includes(query);
			});
			list.replaceChildren();
			if (!rows.length) {
				const emptyText = messageFilter === "unread" ? "No unread conversations."
					: messageFilter === "online" ? "No one in your conversations is online right now."
						: messageFilter === "archived" ? "No archived conversations."
							: "No conversations yet. Search for a student to start one.";
				list.append(makeElement("p", "message-empty-list", emptyText));
				return;
			}
			rows.forEach(({ conversation, person, otherId, lastMessage, unread }) => {
				const card = makeElement("button", `message-conversation${conversation.id === selectedConversationId ? " selected" : ""}${unread ? " has-unread" : ""}`);
				card.type = "button";
				card.dataset.action = "open-conversation";
				card.dataset.conversationId = conversation.id;
				const avatarWrap = makeElement("span", "message-avatar-wrap");
				avatarWrap.append(makeProfileImage(person.avatar_url, person.display_name));
				avatarWrap.append(makePresenceIndicator(otherId));
				const body = makeElement("span", "message-conversation-body");
				const title = makeElement("span", "message-conversation-title");
				title.append(makeElement("strong", "", person.display_name));
				title.append(makeElement("small", "", lastMessage ? formatTime(lastMessage.created_at) : "New"));
				const preview = makeElement("span", "message-preview", lastMessage
					? `${lastMessage.sender_id === userId ? "You: " : ""}${lastMessage.content}`
					: `@${person.username}`);
				if (muted.has(conversation.id)) preview.append(makeElement("span", "muted-label", " · muted"));
				body.append(title, preview);
				card.append(avatarWrap, body);
				if (unread) card.append(makeElement("span", "message-unread-count", String(unread)));
				list.append(card);
			});
		};
		renderList();
		sidebar.append(list);
		workspace.append(sidebar);
		const panel = makeElement("section", "message-panel");
		panel.id = "message-panel";
		workspace.append(panel);
		featureView.append(workspace);
		if (selectedConversationId) {
			await renderConversation(selectedConversationId, page, panel, unreadByConversation);
		} else {
			const empty = makeElement("div", "message-empty-state");
			empty.append(makeElement("span", "message-empty-icon", "✉"), makeElement("h3", "", "Your conversations, in one place"), makeElement("p", "", "Choose a conversation or search for an RTT student to start a private chat."));
			panel.append(empty);
		}
		searchInput.addEventListener("input", () => {
			messageQuery = searchInput.value.trim();
			renderList();
		});
	}

	async function renderConversation(conversationId, page = 0, panel = document.getElementById("message-panel"), unreadByConversation = new Map()) {
		const { data: conversation, error } = await supabaseClient.from("conversations")
			.select("id,member_a,member_b").eq("id", conversationId).single();
		if (error) throw error;
		if (![conversation.member_a, conversation.member_b].includes(userId)) throw new Error("You are not a member of this conversation.");
		const otherId = conversation.member_a === userId ? conversation.member_b : conversation.member_a;
		const { data: person, error: personError } = await supabaseClient.from("profiles")
			.select("display_name,username,avatar_url").eq("id", otherId).single();
		if (personError) throw personError;
		const offset = page * 50;
		const { data: messagesDescending, error: messageError } = await supabaseClient.from("messages")
			.select("id,sender_id,content,created_at,read_at,reply_to_id,edited_at")
			.eq("conversation_id", conversationId).order("created_at", { ascending: false }).range(0, offset + 49);
		if (messageError) throw messageError;
		const messages = messagesDescending.slice().reverse();
		const replyIds = [...new Set(messages.map((message) => message.reply_to_id).filter(Boolean))];
		const { data: replies, error: replyError } = replyIds.length
			? await supabaseClient.from("messages").select("id,content,sender_id").in("id", replyIds)
			: { data: [], error: null };
		if (replyError) throw replyError;
		const repliesById = new Map(replies.map((reply) => [reply.id, reply]));
		const section = makeElement("section", "message-panel-card");
		const header = makeElement("header", "message-chat-header");
		const headerPerson = makeElement("div", "message-chat-person");
		headerPerson.append(makeProfileImage(person.avatar_url, person.display_name), makePresenceIndicator(otherId));
		const personText = makeElement("span", "");
		const personMeta = makeElement("small", "", `@${person.username} · ${onlineUsers.has(otherId) ? "Online" : "Offline"}`);
		personMeta.dataset.presenceLabel = otherId;
		personMeta.dataset.username = person.username;
		personText.append(makeElement("strong", "", person.display_name), personMeta);
		headerPerson.append(personText);
		const controls = makeElement("div", "message-conversation-controls");
		const muted = readPreferenceSet("rtt-muted-conversations");
		const archived = readPreferenceSet("rtt-archived-conversations");
		const muteButton = makeElement("button", "outline-button", muted.has(conversationId) ? "Unmute" : "Mute");
		muteButton.type = "button";
		muteButton.dataset.action = "toggle-mute-conversation";
		muteButton.dataset.conversationId = conversationId;
		const archiveButton = makeElement("button", "outline-button", archived.has(conversationId) ? "Unarchive" : "Archive");
		archiveButton.type = "button";
		archiveButton.dataset.action = "toggle-archive-conversation";
		archiveButton.dataset.conversationId = conversationId;
		controls.append(muteButton, archiveButton);
		header.append(headerPerson, controls);
		const lines = makeElement("div", "message-list");
		lines.id = "message-list";
		if (!messages.length && page === 0) {
			lines.append(makeElement("p", "message-empty-list", "This is the start of the conversation. Say hello."));
		}
		messages.forEach((message) => {
			const row = makeElement("article", `message-row${message.sender_id === userId ? " mine" : ""}`);
			const bubble = makeElement("div", `message-line${message.sender_id === userId ? " mine" : ""}`);
			if (message.reply_to_id) {
				const replied = repliesById.get(message.reply_to_id);
				bubble.append(makeElement("blockquote", "message-reply-quote", replied
					? `${replied.sender_id === userId ? "You" : person.display_name}: ${replied.content}`
					: "Reply to an earlier message"));
			}
			bubble.append(makeElement("p", "message-text", message.content));
			const meta = makeElement("div", "message-meta");
			meta.append(makeElement("time", "", formatTime(message.created_at)));
			if (message.edited_at) meta.append(makeElement("span", "", "Edited"));
			if (message.sender_id === userId && message.read_at) meta.append(makeElement("span", "message-read-status", "Seen"));
			bubble.append(meta);
			row.append(bubble);
			const actions = makeElement("div", "message-actions");
			const replyButton = makeElement("button", "message-action", "Reply");
			replyButton.type = "button";
			replyButton.dataset.action = "reply-message";
			replyButton.dataset.messageId = message.id;
			replyButton.dataset.messageContent = message.content;
			actions.append(replyButton);
			if (message.sender_id === userId) {
				const editButton = makeElement("button", "message-action", "Edit");
				editButton.type = "button";
				editButton.dataset.action = "edit-message";
				editButton.dataset.messageId = message.id;
				editButton.dataset.messageContent = message.content;
				const deleteButton = makeElement("button", "message-action danger-action", "Delete");
				deleteButton.type = "button";
				deleteButton.dataset.action = "delete-message";
				deleteButton.dataset.messageId = message.id;
				actions.append(editButton, deleteButton);
			}
			row.append(actions);
			lines.append(row);
		});
		const composer = makeElement("form", "message-composer");
		composer.dataset.featureForm = "send-message";
		composer.dataset.conversationId = conversationId;
		const replyState = makeElement("div", "message-reply-state");
		replyState.hidden = true;
		replyState.id = "message-reply-state";
		const replyLabel = makeElement("span", "", "");
		const cancelReply = makeElement("button", "message-action", "Cancel");
		cancelReply.type = "button";
		cancelReply.dataset.action = "cancel-message-reply";
		replyState.append(replyLabel, cancelReply);
		composer.append(replyState);
		const editor = document.createElement("textarea");
		editor.name = "content";
		editor.rows = 1;
		editor.maxLength = 2000;
		editor.required = true;
		editor.placeholder = "Write a message…";
		editor.setAttribute("aria-label", "Write a message");
		composer.append(editor);
		const composerActions = makeElement("div", "message-composer-actions");
		const emojiButton = makeElement("button", "outline-button", "🙂 Emoji");
		emojiButton.type = "button";
		emojiButton.dataset.action = "toggle-emoji-picker";
		const emojiPicker = makeElement("div", "message-emoji-picker");
		emojiPicker.hidden = true;
		["🙂", "😂", "🙌", "🔥", "❤️", "👍", "✨", "🎉"].forEach((emoji) => {
			const option = makeElement("button", "message-emoji", emoji);
			option.type = "button";
			option.dataset.action = "insert-message-emoji";
			option.dataset.emoji = emoji;
			emojiPicker.append(option);
		});
		emojiPicker.setAttribute("aria-label", "Choose an emoji");
		composerActions.append(emojiButton, emojiPicker);
		const send = makeFormButton("Send message", "post-button");
		send.classList.add("message-send-button");
		composerActions.append(send);
		const status = addFeatureStatus(composer, "");
		status.setAttribute("aria-live", "polite");
		composer.append(composerActions);
		const older = makeElement("button", "message-load-older", "Load older messages");
		older.type = "button";
		older.dataset.action = "load-older-messages";
		if (messagesDescending.length < offset + 50) older.hidden = true;
		section.append(header, older, lines, composer);
		panel.replaceChildren(section);
		lines.scrollTop = page ? 0 : lines.scrollHeight;
		if (page === 0) {
			if (unreadByConversation.get(conversationId)) {
				const { error: readError } = await supabaseClient.from("messages").update({ read_at: new Date().toISOString() })
					.eq("conversation_id", conversationId).neq("sender_id", userId).is("read_at", null);
				if (readError) throw readError;
				unreadByConversation.set(conversationId, 0);
				const conversationCard = featureView.querySelector(`.message-conversation[data-conversation-id="${CSS.escape(conversationId)}"]`);
				conversationCard?.classList.remove("has-unread");
				conversationCard?.querySelector(".message-unread-count")?.remove();
				if (messageFilter === "unread" && conversationCard) {
					conversationCard.remove();
					if (!featureView.querySelector(".message-conversation")) {
						featureView.querySelector(".message-conversation-list")?.append(makeElement("p", "message-empty-list", "No unread conversations."));
					}
				}
				await updateActivityCounts();
			}
		}
	}

	async function startConversation(otherId) {
		if (!otherId || otherId === userId) return;
		const [memberA, memberB] = [userId, otherId].sort();
		const { data: existing, error: findError } = await supabaseClient.from("conversations")
			.select("id").eq("member_a", memberA).eq("member_b", memberB).maybeSingle();
		if (findError) throw findError;
		if (existing) return showView("messages", existing.id);
		const { data: conversation, error } = await supabaseClient.from("conversations")
			.insert({ member_a: memberA, member_b: memberB }).select("id").single();
		if (error) throw error;
		await showView("messages", conversation.id);
	}

	async function renderLeaderboard() {
		featureView.replaceChildren();
		addFeatureHeading("RTT leaderboard", "Helpful answers and positive community contributions earn points.");
		const { data: students, error } = await supabaseClient.from("profiles")
			.select("id,display_name,username,avatar_url,points").order("points", { ascending: false }).limit(25);
		if (error) throw error;
		students.forEach((student, index) => {
			const card = makeElement("article", "feature-card feature-row");
			card.append(makeElement("span", "leader-rank", String(index + 1).padStart(2, "0")), makeProfileImage(student.avatar_url, student.display_name));
			const info = makeElement("div", "feature-grow");
			info.append(makeElement("strong", "", student.display_name), makeElement("p", "feature-meta", `@${student.username}`));
			card.append(info, makeElement("strong", "leader-points", `${student.points} pts`));
			if (student.points >= 25) card.append(makeElement("span", "achievement-badge", "HELPFUL"));
			featureView.append(card);
		});
	}

	async function renderSettings() {
		featureView.replaceChildren();
		addFeatureHeading("Settings", "Your account, privacy, and workspace preferences.");
		const profileSettings = currentProfile.settings || {};
		const profileButton = makeElement("button", "outline-button", "Edit profile");
		profileButton.type = "button";
		profileButton.dataset.action = "edit-profile";
		const card = makeElement("article", "feature-card settings-overview");
		const identity = makeElement("div", "settings-identity");
		identity.append(makeProfileImage(currentProfile.avatar_url, currentProfile.display_name, "avatar settings-avatar"));
		const identityCopy = makeElement("div", "");
		identityCopy.append(makeElement("span", "settings-kicker", "ACCOUNT & PROFILE"), makeElement("h3", "", currentProfile.display_name));
		identityCopy.append(makeElement("p", "feature-meta", `@${currentProfile.username}`));
		identity.append(identityCopy);
		card.append(
			identity,
			makeElement("p", "settings-email", `Sign-in email · ${signedInEmail || "Email address unavailable"} · Private`),
			makeElement("p", "", "Update your profile details and picture from your profile editor."),
			profileButton
		);
		if (currentProfile.is_admin) {
			const adminButton = makeElement("button", "outline-button", "Open admin tools");
			adminButton.type = "button";
			adminButton.dataset.action = "admin-panel";
			card.append(adminButton);
		}
		featureView.append(card);
		const security = makeElement("form", "feature-form");
		security.dataset.featureForm = "password";
		security.append(makeElement("h3", "", "Change password"));
		addField(security, "New password (at least 8 characters)", "password", "password", "", { required: true, maxLength: 72 });
		security.append(makeFormButton("Update password"));
		addFeatureStatus(security, "");
		featureView.append(security);

		const emailForm = makeElement("form", "feature-form");
		emailForm.dataset.featureForm = "email";
		emailForm.append(makeElement("h3", "", "Sign-in email"));
		addField(emailForm, "New email address", "email", "email", signedInEmail, { required: true, maxLength: 254 });
		emailForm.append(makeElement("p", "feature-meta", "Supabase will send a confirmation link before your sign-in email changes."));
		emailForm.append(makeFormButton("Update email"));
		addFeatureStatus(emailForm, "");
		featureView.append(emailForm);

		const preferences = makeElement("form", "feature-form");
		preferences.dataset.featureForm = "preferences";
		preferences.append(makeElement("h3", "", "Privacy, notifications & appearance"));
		preferences.append(makeElement("p", "settings-section-label", "PROFILE VISIBILITY"));
		const appendToggle = (name, labelText, checked) => {
			const label = makeElement("label", "preference-toggle");
			const input = document.createElement("input");
			input.type = "checkbox";
			input.name = name;
			input.checked = checked;
			label.append(input, document.createTextNode(` ${labelText}`));
			preferences.append(label);
		};
		appendToggle("discoverable", "Let RTT members find your profile", currentProfile.discoverable !== false);
		appendToggle("showCourses", "Display my courses on my RTT profile", profileSettings.show_courses !== false);
		appendToggle("showYearLevel", "Display my year level on my RTT profile", profileSettings.show_year_level !== false);
		preferences.append(makeElement("p", "settings-section-label", "ACTIVITY ALERTS"));
		appendToggle("notifications", "Enable in-app notifications", currentProfile.notifications_enabled !== false);
		appendToggle("notifyLikes", "Alerts for post likes", profileSettings.notify_likes !== false);
		appendToggle("notifyComments", "Alerts for comments and replies", profileSettings.notify_comments !== false);
		appendToggle("notifyFollows", "Alerts for new followers", profileSettings.notify_follows !== false);
		appendToggle("notifyMessages", "Alerts for private messages", profileSettings.notify_messages !== false);
		preferences.append(makeElement("p", "settings-section-label", "APPEARANCE & ACCESSIBILITY"));
		appendToggle("reducedMotion", "Reduce interface motion", getPreference("rtt-reduced-motion") === "true");
		appendToggle("compact", "Use a more compact feed", getPreference("rtt-compact-feed") === "true");
		appendToggle("highContrast", "Increase interface contrast", getPreference("rtt-high-contrast") === "true");
		const themeLabel = makeElement("label", "", "Color theme");
		const theme = document.createElement("select");
		theme.name = "theme";
		[["amber", "RTT Forge"], ["midnight", "Midnight Steel"], ["emerald", "Emerald"], ["violet", "Violet"], ["rose", "Rose"], ["light", "Light Mode"]].forEach(([value, text]) => {
			const option = makeElement("option", "", text);
			option.value = value;
			option.selected = (profileSettings.theme || getPreference("rtt-theme") || "amber") === value;
			theme.append(option);
		});
		themeLabel.append(theme);
		preferences.append(themeLabel);
		const accentLabel = makeElement("label", "", "Accent & background color");
		const accent = document.createElement("select");
		accent.name = "accent";
		[["amber", "Copper"], ["midnight", "Steel blue"], ["emerald", "Emerald"], ["violet", "Violet"], ["rose", "Rose"]].forEach(([value, text]) => {
			const option = makeElement("option", "", text);
			option.value = value;
			option.selected = (profileSettings.accent || getPreference("rtt-accent") || "amber") === value;
			accent.append(option);
		});
		accentLabel.append(accent);
		accentLabel.append(makeElement("small", "feature-meta", "Choosing a color also applies its matching full-interface palette."));
		preferences.append(accentLabel);
		const layoutLabel = makeElement("label", "", "Layout density");
		const layout = document.createElement("select");
		layout.name = "layout";
		[["comfortable", "Comfortable spacing"], ["compact", "Compact spacing"]].forEach(([value, text]) => {
			const option = makeElement("option", "", text);
			option.value = value;
			option.selected = (profileSettings.layout || getPreference("rtt-layout") || "comfortable") === value;
			layout.append(option);
		});
		layoutLabel.append(layout);
		preferences.append(layoutLabel);
		const fontLabel = makeElement("label", "", "Font size");
		const fontSize = document.createElement("select");
		fontSize.name = "fontSize";
		[["small", "Small"], ["default", "Default"], ["large", "Large"]].forEach(([value, text]) => {
			const option = makeElement("option", "", text);
			option.value = value;
			option.selected = (profileSettings.font_size || getPreference("rtt-font-size") || "default") === value;
			fontSize.append(option);
		});
		fontLabel.append(fontSize);
		preferences.append(fontLabel);
		const preview = makeElement("article", "theme-preview");
		preview.id = "theme-preview";
		preview.dataset.theme = theme.value;
		preview.dataset.accent = accent.value;
		preview.append(makeElement("span", "settings-kicker", "LIVE PREVIEW"), makeElement("strong", "", "RTT community"), makeElement("p", "", "A quick look at your selected color and surface style."));
		const previewButton = makeElement("span", "theme-preview-button", "Preview action");
		preview.append(previewButton);
		preferences.append(preview);
		preferences.append(makeFormButton("Save preferences"));
		addFeatureStatus(preferences, "");
		const reset = makeElement("button", "outline-button danger", "Reset settings to defaults");
		reset.type = "button";
		reset.dataset.action = "reset-settings";
		preferences.append(reset);
		featureView.append(preferences);

		const exportCard = makeElement("article", "feature-card settings-export");
		exportCard.append(
			makeElement("h3", "", "Your RTT data"),
			makeElement("p", "", "Download a JSON copy of your profile, posts, comments, follows, bookmarks, poll votes, and private conversations. Keep the downloaded file somewhere safe.")
		);
		const exportButton = makeElement("button", "outline-button", "Download my data");
		exportButton.type = "button";
		exportButton.dataset.action = "export-data";
		exportCard.append(exportButton);
		addFeatureStatus(exportCard, "");
		featureView.append(exportCard);
	}

	function handlePreferencePreview(event) {
		const form = event.target.closest('form[data-feature-form="preferences"]');
		if (!form) return;
		let theme = form.elements.theme.value;
		if (event.target.name === "theme") {
			form.elements.accent.value = theme === "light" ? "amber" : theme;
		} else if (event.target.name === "accent") {
			theme = form.elements.accent.value;
			form.elements.theme.value = theme;
		}
		const accent = form.elements.accent.value;
		document.body.dataset.theme = theme;
		document.body.dataset.accent = accent;
		document.documentElement.style.setProperty("--accent", themeAccents[accent] || themeAccents.amber);
		document.body.classList.toggle("reduce-motion", form.elements.reducedMotion.checked);
		document.body.classList.toggle("compact-feed", form.elements.compact.checked);
		document.body.classList.toggle("high-contrast", form.elements.highContrast.checked);
		document.body.classList.toggle("large-text", form.elements.fontSize.value === "large");
		document.body.classList.toggle("small-text", form.elements.fontSize.value === "small");
		document.body.classList.toggle("compact-layout", form.elements.layout.value === "compact");
		document.body.classList.toggle("comfortable-layout", form.elements.layout.value !== "compact");
		document.body.dataset.fontSize = form.elements.fontSize.value;
		const preview = form.querySelector(".theme-preview");
		preview.dataset.theme = theme;
		preview.dataset.accent = accent;
	}

	function handleMessageKeydown(event) {
		if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
		const form = event.target.closest('form[data-feature-form="send-message"]');
		if (!form || event.target !== form.elements.content) return;
		event.preventDefault();
		form.requestSubmit();
	}

	function handleMessageInput(event) {
		const form = event.target.closest('form[data-feature-form="send-message"]');
		if (!form || event.target !== form.elements.content) return;
		event.target.style.height = "auto";
		event.target.style.height = `${Math.min(event.target.scrollHeight, 130)}px`;
	}

	function handleMessageComposerFocusout(event) {
		if (!event.target.closest('form[data-feature-form="send-message"]') || !messageRefreshPending) return;
		window.setTimeout(() => {
			const editor = featureView.querySelector('form[data-feature-form="send-message"] textarea');
			if (activeView !== "messages" || document.activeElement === editor) return;
			messageRefreshPending = false;
			void showView("messages", activeConversationId);
		}, 350);
	}

	async function downloadAccountData() {
		const [profileResult, postsResult, commentsResult, followsResult, bookmarksResult, votesResult, conversationsResult] = await Promise.all([
			supabaseClient.from("profiles").select("*").eq("id", userId).single(),
			fetchAllRows(() => supabaseClient.from("posts").select("*").eq("user_id", userId).order("created_at", { ascending: false })),
			fetchAllRows(() => supabaseClient.from("comments").select("*").eq("user_id", userId).order("created_at", { ascending: false })),
			fetchAllRows(() => supabaseClient.from("follows").select("*").or(`follower_id.eq.${userId},following_id.eq.${userId}`)),
			fetchAllRows(() => supabaseClient.from("post_bookmarks").select("*").eq("user_id", userId)),
			fetchAllRows(() => supabaseClient.from("poll_votes").select("*").eq("user_id", userId)),
			fetchAllRows(() => supabaseClient.from("conversations").select("*").or(`member_a.eq.${userId},member_b.eq.${userId}`))
		]);
		if (profileResult.error) throw profileResult.error;
		const conversationIds = conversationsResult.map((conversation) => conversation.id);
		let messages = [];
		if (conversationIds.length) {
			const batches = [];
			for (let offset = 0; offset < conversationIds.length; offset += 100) {
				batches.push(conversationIds.slice(offset, offset + 100));
			}
			messages = (await Promise.all(batches.map((batch) => fetchAllRows(() => supabaseClient.from("messages").select("*")
				.in("conversation_id", batch).order("created_at"))))).flat();
		}
		const exportData = {
			exported_at: new Date().toISOString(),
			account: { email: signedInEmail },
			profile: profileResult.data,
			posts: postsResult,
			comments: commentsResult,
			follows: followsResult,
			bookmarks: bookmarksResult,
			poll_votes: votesResult,
			conversations: conversationsResult,
			messages
		};
		const fileUrl = URL.createObjectURL(new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" }));
		const link = makeElement("a");
		link.href = fileUrl;
		link.download = `rtt-data-${new Date().toISOString().slice(0, 10)}.json`;
		document.body.append(link);
		link.click();
		link.remove();
		window.setTimeout(() => URL.revokeObjectURL(fileUrl), 1000);
	}

	async function renderAdmin() {
		if (!currentProfile?.is_admin) throw new Error("Admin access is required.");
		featureView.replaceChildren();
		addFeatureHeading("Moderation dashboard", "Review member reports and remove harmful content.", "RTT ADMIN");
		const { data: reports, error } = await supabaseClient.from("content_reports")
			.select("id,post_id,comment_id,reported_user_id,reason,status,created_at,profiles!content_reports_reporter_id_fkey(display_name)")
			.eq("status", "open").order("created_at", { ascending: true }).limit(100);
		if (error) throw error;
		reports.forEach((report) => {
			const card = makeElement("article", "feature-card");
			card.append(
				makeElement("p", "feature-meta", `Reported by ${report.profiles?.display_name || "member"} · ${formatTime(report.created_at)}`),
				makeElement("p", "", report.reason)
			);
			const actions = makeElement("div", "feature-actions");
			const resolve = makeElement("button", "outline-button", "Dismiss report");
			resolve.type = "button";
			resolve.dataset.action = "resolve-report";
			resolve.dataset.reportId = report.id;
			actions.append(resolve);
			if (report.post_id && !report.comment_id) {
				const remove = makeElement("button", "outline-button danger", "Remove post");
				remove.type = "button";
				remove.dataset.action = "moderate-post";
				remove.dataset.postId = report.post_id;
				remove.dataset.reportId = report.id;
				actions.append(remove);
			}
			if (report.comment_id) {
				const remove = makeElement("button", "outline-button danger", "Remove reply");
				remove.type = "button";
				remove.dataset.action = "moderate-comment";
				remove.dataset.commentId = report.comment_id;
				remove.dataset.reportId = report.id;
				actions.append(remove);
			}
			card.append(actions);
			featureView.append(card);
		});
		if (!reports.length) featureView.append(makeElement("p", "empty-feed", "No open reports. RTT is looking good."));
		const users = makeElement("article", "feature-card");
		const { count: memberCount, error: countError } = await supabaseClient.from("profiles").select("id", { count: "exact", head: true });
		if (countError) throw countError;
		users.append(makeElement("h3", "", "Member management"), makeElement("p", "feature-meta", `${memberCount || 0} registered students. Admin roles grant access to these moderation tools.`));
		featureView.append(users);
		const searchForm = makeElement("form", "feature-form");
		searchForm.dataset.featureForm = "admin-users";
		addField(searchForm, "Find a member", "query", "search", adminSearchQuery, { placeholder: "Name or username" });
		searchForm.append(makeFormButton("Search members"));
		addFeatureStatus(searchForm, "");
		featureView.append(searchForm);
		const memberQuery = cleanSearchTerm(adminSearchQuery);
		let memberRequest = supabaseClient.from("profiles").select("id,display_name,username,is_admin").order("display_name").limit(20);
		if (memberQuery) memberRequest = memberRequest.or(`display_name.ilike.%${memberQuery}%,username.ilike.%${memberQuery}%`);
		const { data: members, error: membersError } = await memberRequest;
		if (membersError) throw membersError;
		members.forEach((member) => {
			const row = makeElement("article", "feature-card feature-row");
			const details = makeElement("div", "feature-grow");
			details.append(makeElement("strong", "", member.display_name), makeElement("p", "feature-meta", `@${member.username}${member.is_admin ? " · ADMIN" : ""}`));
			const action = makeElement("button", "outline-button", member.is_admin ? "Remove admin" : "Make admin");
			action.type = "button";
			action.dataset.action = "toggle-admin";
			action.dataset.userId = member.id;
			action.dataset.makeAdmin = String(!member.is_admin);
			row.append(details, action);
			featureView.append(row);
		});
		if (!members.length) featureView.append(makeElement("p", "feature-meta", "No members match that search."));
	}

	async function handleFeatureSubmit(event) {
		const form = event.target.closest("form[data-feature-form]");
		if (!form) {
			if (event.target.matches(".comment-form")) await handleCommentSubmit(event);
			return;
		}
		event.preventDefault();
		const data = new FormData(form);
		const submit = form.querySelector('button[type="submit"]');
		const status = form.querySelector(".feature-status");
		submit.disabled = true;
		status.textContent = "";
		status.classList.remove("success");
		try {
			const type = form.dataset.featureForm;
			if (type === "profile") {
				const username = String(data.get("username")).trim().toLowerCase();
				const name = String(data.get("display_name")).trim();
				if (!/^[a-z0-9_]{3,24}$/.test(username)) throw new Error("Usernames must be 3–24 characters using letters, numbers, or underscores.");
				if (!name || name.length > 50) throw new Error("Display names must be between 1 and 50 characters.");
				const avatarFile = form.elements.avatar.files[0];
				const coverFile = form.elements.cover.files[0];
				const avatarUrl = avatarFile ? await uploadImage(avatarFile, "avatars") : currentProfile.avatar_url;
				const coverUrl = coverFile ? await uploadImage(coverFile, "covers") : currentProfile.cover_url;
				const profileUpdate = {
					display_name: name,
					username,
					bio: String(data.get("bio")).trim(),
					courses: String(data.get("courses")).split(",").map((course) => course.trim()).filter(Boolean).slice(0, 8),
					year_level: data.get("year_level"),
					avatar_url: avatarUrl,
					cover_url: coverUrl,
					updated_at: new Date().toISOString()
				};
				const { data: updated, error } = await supabaseClient.from("profiles").update(profileUpdate).eq("id", userId)
					.select("id,display_name,username,avatar_url,cover_url,bio,courses,year_level,points,is_admin,discoverable,notifications_enabled,settings").single();
				if (error) throw error;
				currentProfile = updated;
				displayName = updated.display_name;
				document.getElementById("signed-in-name").textContent = displayName;
				setProfileImages(updated);
				document.getElementById("composer-avatar").textContent = Array.from(displayName)[0]?.toUpperCase() || "S";
				await showView("profile");
			} else if (type === "create-group") {
				const name = String(data.get("name")).trim();
				if (name.length < 2) throw new Error("Group name must have at least two characters.");
				const { data: group, error } = await supabaseClient.from("study_groups").insert({
					owner_id: userId, name, course: String(data.get("course")).trim(), description: String(data.get("description")).trim()
				}).select("id").single();
				if (error) throw error;
				const { error: joinError } = await supabaseClient.from("study_group_members").insert({ group_id: group.id, user_id: userId });
				if (joinError) throw joinError;
				await renderGroups();
			} else if (type === "group-message") {
				const content = String(data.get("content")).trim();
				if (!content || content.length > 2000) throw new Error("Group messages must be between 1 and 2,000 characters.");
				const { error } = await supabaseClient.from("study_group_messages").insert({ group_id: form.dataset.groupId, user_id: userId, content });
				if (error) throw error;
				await renderGroupDetail(form.dataset.groupId);
			} else if (type === "create-event") {
				const startsAt = new Date(String(data.get("starts_at")));
				if (Number.isNaN(startsAt.getTime()) || startsAt <= new Date()) throw new Error("Choose an event time in the future.");
				const { error } = await supabaseClient.from("campus_events").insert({
					organizer_id: userId,
					title: String(data.get("title")).trim(),
					description: String(data.get("description")).trim(),
					location: String(data.get("location")).trim(),
					starts_at: startsAt.toISOString()
				});
				if (error) throw error;
				await renderEvents();
			} else if (type === "search") {
				await searchDirectory(String(data.get("query")), "all");
			} else if (type === "message-search") {
				const query = cleanSearchTerm(data.get("query"));
				if (query.length < 2) throw new Error("Enter at least two characters to search for a student.");
				const { data: people, error } = await supabaseClient.from("profiles")
					.select("id,display_name,username,avatar_url")
					.or(`display_name.ilike.%${query}%,username.ilike.%${query}%`).neq("id", userId).limit(15);
				if (error) throw error;
				const list = form.querySelector(".message-search-results");
				list.replaceChildren();
				people.forEach((person) => {
					const card = makeElement("article", "feature-card feature-row");
					card.append(makeProfileImage(person.avatar_url, person.display_name), makeElement("span", "feature-grow", `${person.display_name} · @${person.username}`));
					const start = makeElement("button", "outline-button", "Message");
					start.type = "button";
					start.dataset.action = "start-chat";
					start.dataset.userId = person.id;
					card.append(start);
					list.append(card);
				});
				if (!people.length) list.append(makeElement("p", "message-search-empty", "No matching students found."));
			} else if (type === "admin-users") {
				adminSearchQuery = String(data.get("query")).trim();
				await renderAdmin();
			} else if (type === "send-message") {
				const content = String(data.get("content")).trim();
				if (!content || content.length > 2000) throw new Error("Messages must be between 1 and 2,000 characters.");
				const result = form.dataset.editMessageId
					? await supabaseClient.rpc("edit_rtt_message", {
						target_message: form.dataset.editMessageId,
						new_content: content
					})
					: await supabaseClient.from("messages").insert({
						conversation_id: form.dataset.conversationId,
						sender_id: userId,
						content,
						reply_to_id: form.dataset.replyTo || null
					});
				const { error } = result;
				if (error) throw error;
				messageRefreshPending = false;
				await renderMessages(form.dataset.conversationId);
			} else if (type === "password") {
				const password = String(data.get("password"));
				if (password.length < 8) throw new Error("Use at least 8 characters for your password.");
				const { error } = await supabaseClient.auth.updateUser({ password });
				if (error) throw error;
				status.textContent = "Password updated.";
				status.classList.add("success");
				form.reset();
			} else if (type === "email") {
				const email = String(data.get("email")).trim();
				if (!email || email === signedInEmail) throw new Error("Enter a different email address.");
				const { error } = await supabaseClient.auth.updateUser({ email });
				if (error) throw error;
				status.textContent = "Check your inbox and follow Supabase’s confirmation link to finish changing your email.";
				status.classList.add("success");
			} else if (type === "preferences") {
				const settings = {
					...(currentProfile.settings || {}),
					theme: String(data.get("theme")),
					accent: String(data.get("accent")),
					layout: String(data.get("layout")),
					font_size: String(data.get("fontSize")),
					show_courses: data.has("showCourses"),
					show_year_level: data.has("showYearLevel"),
					notify_likes: data.has("notifyLikes"),
					notify_comments: data.has("notifyComments"),
					notify_follows: data.has("notifyFollows"),
					notify_messages: data.has("notifyMessages")
				};
				const preferenceUpdate = {
					discoverable: data.has("discoverable"),
					notifications_enabled: data.has("notifications"),
					settings,
					updated_at: new Date().toISOString()
				};
				const { data: updated, error } = await supabaseClient.from("profiles").update(preferenceUpdate)
					.eq("id", userId).select("id,display_name,username,avatar_url,cover_url,bio,courses,year_level,points,is_admin,discoverable,notifications_enabled,settings").single();
				if (error) throw error;
				currentProfile = updated;
				setPreference("rtt-reduced-motion", String(data.has("reducedMotion")));
				setPreference("rtt-compact-feed", String(data.has("compact")));
				setPreference("rtt-high-contrast", String(data.has("highContrast")));
				setPreference("rtt-theme", settings.theme);
				setPreference("rtt-accent", settings.accent);
				setPreference("rtt-layout", settings.layout);
				setPreference("rtt-font-size", settings.font_size);
				applyDevicePreferences(settings);
				status.textContent = "Your account and appearance preferences are saved.";
				status.classList.add("success");
			}
		} catch (error) {
			status.textContent = errorMessage(error, "Could not save your changes.");
		} finally {
			if (submit.isConnected) submit.disabled = false;
		}
	}

	async function handleFeatureAction(event) {
		const button = event.target.closest("button[data-action]");
		if (!button) return;
		const action = button.dataset.action;
		if (["like", "comment", "save", "edit-post", "delete-post", "report-post", "delete-comment", "report-comment", "vote-poll", "reply-comment", "helpful-comment", "search-user", "view-user", "clear-comment-image"].includes(action)) {
			await handlePostAction(event);
			return;
		}
		try {
			if (action === "message-filter") {
				messageFilter = button.dataset.filter;
				await showView("messages", activeConversationId);
			} else if (action === "toggle-mute-conversation") {
				const muted = readPreferenceSet("rtt-muted-conversations");
				if (muted.has(button.dataset.conversationId)) muted.delete(button.dataset.conversationId);
				else muted.add(button.dataset.conversationId);
				savePreferenceSet("rtt-muted-conversations", muted);
				await showView("messages", activeConversationId);
			} else if (action === "toggle-archive-conversation") {
				const archived = readPreferenceSet("rtt-archived-conversations");
				if (archived.has(button.dataset.conversationId)) archived.delete(button.dataset.conversationId);
				else archived.add(button.dataset.conversationId);
				savePreferenceSet("rtt-archived-conversations", archived);
				await showView("messages", activeConversationId);
			} else if (action === "reply-message") {
				const form = featureView.querySelector('form[data-feature-form="send-message"]');
				form.dataset.replyTo = button.dataset.messageId;
				const replyState = form.querySelector(".message-reply-state");
				replyState.hidden = false;
				replyState.firstElementChild.textContent = `Replying to: ${button.dataset.messageContent.slice(0, 120)}`;
				form.elements.content.focus();
			} else if (action === "cancel-message-reply") {
				const form = button.closest("form");
				delete form.dataset.replyTo;
				delete form.dataset.editMessageId;
				form.querySelector(".message-reply-state").hidden = true;
				form.querySelector('button[type="submit"]').textContent = "Send message";
			} else if (action === "toggle-emoji-picker") {
				const picker = button.closest("form").querySelector(".message-emoji-picker");
				picker.hidden = !picker.hidden;
			} else if (action === "insert-message-emoji") {
				const form = button.closest("form");
				const editor = form.elements.content;
				const start = editor.selectionStart;
				const end = editor.selectionEnd;
				editor.setRangeText(button.dataset.emoji, start, end, "end");
				editor.focus();
				editor.dispatchEvent(new Event("input", { bubbles: true }));
				button.closest(".message-emoji-picker").hidden = true;
			} else if (action === "load-older-messages") {
				await renderMessages(activeConversationId, activeMessagePage + 1);
			} else if (action === "edit-message") {
				const form = featureView.querySelector('form[data-feature-form="send-message"]');
				form.dataset.editMessageId = button.dataset.messageId;
				delete form.dataset.replyTo;
				form.elements.content.value = button.dataset.messageContent;
				form.elements.content.focus();
				form.querySelector(".message-reply-state").hidden = false;
				form.querySelector(".message-reply-state").firstElementChild.textContent = "Editing your message";
				form.querySelector('button[type="submit"]').textContent = "Save edit";
			} else if (action === "delete-message") {
				if (!window.confirm("Delete this message? This cannot be undone.")) return;
				const { error } = await supabaseClient.from("messages").delete()
					.eq("id", button.dataset.messageId).eq("sender_id", userId).eq("conversation_id", activeConversationId);
				if (error) throw error;
				await renderMessages(activeConversationId, activeMessagePage);
			} else if (action === "reset-settings") {
				if (!window.confirm("Reset RTT settings to the default theme and preferences? Your profile, posts, and messages will not be changed.")) return;
				const defaults = {
					...(currentProfile.settings || {}),
					theme: "amber",
					accent: "amber",
					layout: "comfortable",
					font_size: "default",
					show_courses: true,
					show_year_level: true,
					notify_likes: true,
					notify_comments: true,
					notify_follows: true,
					notify_messages: true
				};
				const { data: updated, error } = await supabaseClient.from("profiles")
					.update({ discoverable: true, notifications_enabled: true, settings: defaults, updated_at: new Date().toISOString() })
					.eq("id", userId)
					.select("id,display_name,username,avatar_url,cover_url,bio,courses,year_level,points,is_admin,discoverable,notifications_enabled,settings").single();
				if (error) throw error;
				currentProfile = updated;
				setPreference("rtt-theme", "amber");
				setPreference("rtt-accent", "amber");
				setPreference("rtt-layout", "comfortable");
				setPreference("rtt-font-size", "default");
				setPreference("rtt-reduced-motion", "false");
				setPreference("rtt-compact-feed", "false");
				setPreference("rtt-high-contrast", "false");
				applyDevicePreferences(defaults);
				await renderSettings();
				const status = featureView.querySelector('form[data-feature-form="preferences"] .feature-status');
				status.textContent = "Settings reset to the RTT defaults.";
				status.classList.add("success");
			} else if (action === "edit-profile") {
				renderProfileEditor();
			} else if (action === "export-data") {
				const status = button.closest(".settings-export").querySelector(".feature-status");
				button.disabled = true;
				try {
					await downloadAccountData();
					status.textContent = "Your RTT data download is ready. Keep the file somewhere private.";
					status.classList.add("success");
				} finally {
					button.disabled = false;
				}
			} else if (action === "admin-panel") {
				await showView("admin");
			} else if (action === "retry-view") {
				await showView(button.dataset.view);
			} else if (action === "view-user") {
				await showView("user-profile", button.dataset.userId);
			} else if (action === "toggle-follow") {
				const targetId = button.dataset.userId;
				if (followingIds.has(targetId)) {
					const { error } = await supabaseClient.from("follows").delete().eq("follower_id", userId).eq("following_id", targetId);
					if (error) throw error;
					followingIds.delete(targetId);
				} else {
					const { error } = await supabaseClient.from("follows").insert({ follower_id: userId, following_id: targetId });
					if (error) throw error;
					followingIds.add(targetId);
				}
				await showView("user-profile", targetId);
			} else if (action === "start-chat") {
				await startConversation(button.dataset.userId);
			} else if (action === "join-group") {
				const { error } = await supabaseClient.from("study_group_members").insert({ group_id: button.dataset.groupId, user_id: userId });
				if (error && error.code !== "23505") throw error;
				await renderGroups();
			} else if (action === "leave-group") {
				const { error } = await supabaseClient.from("study_group_members").delete().eq("group_id", button.dataset.groupId).eq("user_id", userId);
				if (error) throw error;
				await renderGroups();
			} else if (action === "open-group") {
				await showView("group-detail", button.dataset.groupId);
			} else if (action === "rsvp-event") {
				const query = supabaseClient.from("event_attendees");
				const result = button.dataset.attending === "true"
					? await query.delete().eq("event_id", button.dataset.eventId).eq("user_id", userId)
					: await query.insert({ event_id: button.dataset.eventId, user_id: userId });
				if (result.error) throw result.error;
				await renderEvents();
			} else if (action === "delete-event") {
				if (!window.confirm("Delete this event?")) return;
				const { error } = await supabaseClient.from("campus_events").delete().eq("id", button.dataset.eventId);
				if (error) throw error;
				await renderEvents();
			} else if (action === "read-notification") {
				const { error } = await supabaseClient.from("notifications").update({ read_at: new Date().toISOString() }).eq("id", button.dataset.notificationId);
				if (error) throw error;
				await renderNotifications();
			} else if (action === "mark-all-read") {
				const { error } = await supabaseClient.from("notifications").update({ read_at: new Date().toISOString() }).is("read_at", null);
				if (error) throw error;
				await renderNotifications();
			} else if (action === "open-conversation") {
				await showView("messages", button.dataset.conversationId);
			} else if (action === "view-post") {
				activeFilter = "all";
				document.getElementById("sort-select").value = "newest";
				if (activeView === "feed") await loadPosts();
				else await showView(activeView);
				const { data: row, error } = await supabaseClient.from("posts")
					.select("id,user_id,guest_id,display_name,category,content,image_url,link_url,poll_options,created_at,profiles!posts_user_id_fkey(display_name,avatar_url),comments(id,user_id,guest_id,parent_comment_id,is_helpful,display_name,content,image_url,created_at,profiles!comments_user_id_fkey(display_name,avatar_url)),likes(user_id,guest_id),poll_votes(user_id,option_index)")
					.eq("id", button.dataset.postId).maybeSingle();
				if (error) throw error;
				if (row && !posts.some((post) => post.id === row.id)) posts.unshift(normalizePost(row));
				await showView("feed");
				feed.querySelector(`[data-post-id="${CSS.escape(button.dataset.postId)}"]`)?.scrollIntoView({ behavior: "smooth" });
			} else if (action === "resolve-report") {
				const { error } = await supabaseClient.from("content_reports").update({ status: "dismissed" }).eq("id", button.dataset.reportId);
				if (error) throw error;
				await renderAdmin();
			} else if (action === "moderate-post") {
				if (!window.confirm("Remove this reported post?")) return;
				const { error } = await supabaseClient.from("posts").delete().eq("id", button.dataset.postId);
				if (error) throw error;
				const { error: reportError } = await supabaseClient.from("content_reports").update({ status: "reviewed" }).eq("id", button.dataset.reportId);
				if (reportError) throw reportError;
				await renderAdmin();
			} else if (action === "moderate-comment") {
				if (!window.confirm("Remove this reported reply?")) return;
				const { error } = await supabaseClient.from("comments").delete().eq("id", button.dataset.commentId);
				if (error) throw error;
				const { error: reportError } = await supabaseClient.from("content_reports").update({ status: "reviewed" }).eq("id", button.dataset.reportId);
				if (reportError) throw reportError;
				await renderAdmin();
			} else if (action === "toggle-admin") {
				if (!window.confirm(`${button.dataset.makeAdmin === "true" ? "Grant" : "Remove"} RTT admin access for this member?`)) return;
				const { error } = await supabaseClient.rpc("set_rtt_admin", {
					target_user: button.dataset.userId,
					make_admin: button.dataset.makeAdmin === "true"
				});
				if (error) throw error;
				if (button.dataset.userId === userId && button.dataset.makeAdmin === "false") {
					currentProfile.is_admin = false;
					document.querySelector(".admin-nav-item").hidden = true;
					await showView("feed");
					return;
				}
				await renderAdmin();
			}
		} catch (error) {
			const status = button.closest(".feature-card, .feature-form")?.querySelector(".feature-status")
				|| featureView.querySelector(".feature-status");
			if (status) status.textContent = errorMessage(error, "Could not complete that action.");
			else console.error("RTT action failed", error);
		}
	}

	async function handleJoinSubmit(event) {
		event.preventDefault();
		if (!supabaseClient) {
			setJoinMessage("Supabase isn’t configured yet. The site owner needs to finish the setup in SETUP.md.");
			return;
		}
		const mode = document.querySelector(".auth-tab.active").dataset.mode;
		const email = document.getElementById("email").value.trim();
		const password = document.getElementById("password").value;
		const name = document.getElementById("display-name").value.trim();
		const button = document.getElementById("auth-submit");
		button.disabled = true;
		setJoinMessage("");
		try {
			let result;
			if (mode === "signup") {
				if (!name) {
					setJoinMessage("Please choose a display name.");
					return;
				}
				result = await supabaseClient.auth.signUp({
					email,
					password,
					options: { data: { display_name: name } }
				});
			} else {
				result = await supabaseClient.auth.signInWithPassword({ email, password });
			}
			if (result.error) throw result.error;
			if (result.data.session) {
				await openMemberSpace(result.data.user);
			} else if (mode === "signup") {
				setAuthMode("login");
				setJoinMessage("Account created. Check your email for a confirmation link, then log in.", true);
				document.getElementById("email").value = email;
			} else {
				setJoinMessage("You’re signed in, but no active session was returned. Please try logging in again.");
			}
		} catch (error) {
			setJoinMessage(errorMessage(error, mode === "signup" ? "Could not create your account." : "Could not log in."));
		} finally {
			button.disabled = false;
		}
	}

	function clearPostImageSelection() {
		const input = document.getElementById("post-image");
		const preview = document.getElementById("post-image-preview");
		if (preview.dataset.objectUrl) URL.revokeObjectURL(preview.dataset.objectUrl);
		delete preview.dataset.objectUrl;
		preview.removeAttribute("src");
		preview.hidden = true;
		input.value = "";
		document.getElementById("post-image-label").textContent = "Add photo";
		document.getElementById("clear-post-image").hidden = true;
	}

	function handlePostImageChange(event) {
		if (event.target.id !== "post-image") return;
		const input = event.target;
		const file = input.files[0];
		if (!file) return;
		if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.type)) {
			clearPostImageSelection();
			setFeedMessage("Choose a JPG, PNG, WebP, or GIF image.");
			return;
		}
		if (file.size > 5 * 1024 * 1024) {
			clearPostImageSelection();
			setFeedMessage("Images must be 5 MB or smaller.");
			return;
		}
		const preview = document.getElementById("post-image-preview");
		if (preview.dataset.objectUrl) URL.revokeObjectURL(preview.dataset.objectUrl);
		preview.dataset.objectUrl = URL.createObjectURL(file);
		preview.src = preview.dataset.objectUrl;
		preview.hidden = false;
		document.getElementById("post-image-label").textContent = file.name.slice(0, 38);
		document.getElementById("clear-post-image").hidden = false;
		setFeedMessage("");
	}

	async function handleCreatePost(event) {
		event.preventDefault();
		if (!userId || !supabaseClient) return;
		const content = document.getElementById("post-content").value.trim();
		const linkText = document.getElementById("post-link").value.trim();
		const category = document.getElementById("post-category").value;
		const pollEnabled = document.getElementById("poll-enabled").checked;
		const pollOptions = pollEnabled
			? [...document.querySelectorAll(".poll-option")].map((input) => input.value.trim()).filter(Boolean)
			: [];
		if (!content) return;
		if (!postCategories.includes(category)) {
			setFeedMessage("Choose a valid post category.");
			return;
		}
		if (pollEnabled && pollOptions.length < 2) {
			setFeedMessage("Add at least two poll options.");
			return;
		}
		if (pollEnabled && !document.getElementById("poll-question").value.trim()) {
			setFeedMessage("Add a question for your poll.");
			return;
		}
		if (pollEnabled && document.getElementById("poll-question").value.trim().length + content.length > 700) {
			setFeedMessage("The poll question and post text must fit within 700 characters.");
			return;
		}
		if (pollEnabled && pollOptions.length > 6) {
			setFeedMessage("Polls can have up to six options.");
			return;
		}
		const file = document.getElementById("post-image").files[0];
		const button = postForm.querySelector('button[type="submit"]');
		const buttonLabel = button.textContent;
		button.disabled = true;
		button.textContent = "Sharing…";
		setFeedMessage(file ? "Uploading your photo and sharing your update…" : "Sharing your update…");
		try {
			let linkUrl = null;
			if (linkText) {
				const parsed = new URL(linkText);
				if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Only HTTP and HTTPS links are supported.");
				linkUrl = parsed.href;
			}
			const imageUrl = file ? await uploadImage(file, "posts") : null;
			const { error } = await supabaseClient.from("posts").insert({
				user_id: userId,
				display_name: displayName,
				category,
				content: pollEnabled ? `${document.getElementById("poll-question").value.trim()}\n\n${content}` : content,
				image_url: imageUrl,
				link_url: linkUrl,
				poll_options: pollOptions
			});
			if (error) throw error;
			clearPostImageSelection();
			postForm.reset();
			document.getElementById("poll-fields").hidden = true;
			document.querySelectorAll(".poll-option").forEach((option, index) => {
				if (index > 1) option.remove();
			});
			if (activeView === "feed") await loadPosts();
			else await showView(activeView);
			document.getElementById("post-content").focus();
		} catch (error) {
			let message = errorMessage(error, "Please try again.");
			if (/image_url|column .* does not exist|schema cache/i.test(message)) {
				message = "The post photo database column is missing. Run the updated supabase-schema.sql in the Supabase SQL Editor, then reload RTT.";
			}
			setFeedMessage(`Could not share your post: ${message}`);
		} finally {
			button.disabled = false;
			button.textContent = buttonLabel;
		}
	}

	async function handlePostAction(event) {
		const tag = event.target.closest("a[data-search-term]");
		if (tag) {
			event.preventDefault();
			await searchDirectory(tag.dataset.searchTerm, "posts");
			return;
		}
		const button = event.target.closest("button[data-action]");
		if (!button) return;
		const action = button.dataset.action;
		if (action === "clear-comment-image") {
			const form = button.closest(".comment-form");
			const imageInput = form?.elements.image;
			const preview = form?.querySelector(".comment-image-preview");
			if (preview?.dataset.objectUrl) URL.revokeObjectURL(preview.dataset.objectUrl);
			if (imageInput) imageInput.value = "";
			if (preview) {
				preview.removeAttribute("src");
				delete preview.dataset.objectUrl;
				preview.hidden = true;
			}
			button.hidden = true;
			return;
		}
		if (action === "search-user") {
			await searchDirectory(button.dataset.searchTerm, "users");
			return;
		}
		if (action === "view-user") {
			await showView("user-profile", button.dataset.userId);
			return;
		}
		if (action === "reply-comment") {
			const form = button.closest(".post-card")?.querySelector(".comment-form");
			if (form) {
				form.elements.parentId.value = button.dataset.commentId;
				form.elements.comment.placeholder = "Write a reply...";
				form.elements.comment.focus();
			}
			return;
		}
		if (button.dataset.action === "comment") {
			const card = button.closest(".post-card");
			card?.querySelector(`form[data-post-id="${CSS.escape(button.dataset.postId)}"] input[name="comment"]`)?.focus();
			return;
		}

		let post = posts.find((item) => item.id === button.dataset.postId);
		if (!post && button.dataset.postId) {
			try {
				const { data, error } = await supabaseClient.from("posts")
					.select("id,user_id,guest_id,display_name,category,content,image_url,link_url,poll_options,created_at,profiles!posts_user_id_fkey(display_name,avatar_url),comments(id,user_id,guest_id,parent_comment_id,is_helpful,display_name,content,image_url,created_at,profiles!comments_user_id_fkey(display_name,avatar_url)),likes(user_id,guest_id),poll_votes(user_id,option_index)")
					.eq("id", button.dataset.postId).maybeSingle();
				if (error) throw error;
				if (data) {
					post = normalizePost(data);
					posts.push(post);
				}
			} catch (error) {
				setFeedMessage(`Could not load that post: ${errorMessage(error, "Please try again.")}`);
				return;
			}
		}
		if (action === "helpful-comment") {
			try {
				const { error } = await supabaseClient.from("comments").update({ is_helpful: true }).eq("id", button.dataset.commentId);
				if (error) throw error;
				if (activeView === "feed") await loadPosts();
				else await showView(activeView);
			} catch (error) {
				setFeedMessage(`Could not mark that answer helpful: ${errorMessage(error, "Please try again.")}`);
			}
			return;
		}
		if (!post) return;
		button.disabled = true;
		try {
			let result;
			if (action === "like") {
				result = post.liked
					? await supabaseClient.from("likes").delete().eq("post_id", post.id).eq("user_id", userId)
					: await supabaseClient.from("likes").insert({ post_id: post.id, user_id: userId });
			} else if (action === "save") {
				result = post.saved
					? await supabaseClient.from("post_bookmarks").delete().eq("post_id", post.id).eq("user_id", userId)
					: await supabaseClient.from("post_bookmarks").insert({ post_id: post.id, user_id: userId });
				if (result.error) throw result.error;
				if (post.saved) {
					bookmarkIds.delete(post.id);
					saveSavedPosts(loadSavedPosts().filter((id) => id !== post.id));
				}
				else bookmarkIds.add(post.id);
			} else if (action === "vote-poll") {
				result = await supabaseClient.from("poll_votes").insert({
					post_id: post.id,
					user_id: userId,
					option_index: Number(button.dataset.optionIndex)
				});
			} else if (action === "edit-post") {
				const updatedContent = window.prompt("Edit your post:", post.content);
				if (updatedContent === null) return;
				if (!updatedContent.trim() || updatedContent.length > 700) throw new Error("Posts must be between 1 and 700 characters.");
				result = await supabaseClient.from("posts").update({ content: updatedContent.trim() }).eq("id", post.id).eq("user_id", userId);
			} else if (action === "delete-post") {
				if (!window.confirm("Delete this post and its replies? This cannot be undone.")) return;
				result = await supabaseClient.from("posts").delete().eq("id", post.id).eq("user_id", userId);
			} else if (action === "report-post") {
				const reason = window.prompt("Why are you reporting this post? (At least 5 characters)");
				if (reason === null) return;
				if (reason.trim().length < 5) throw new Error("Please provide a reason of at least 5 characters.");
				result = await supabaseClient.from("content_reports").insert({
					reporter_id: userId, post_id: post.id, reported_user_id: post.userId, reason: reason.trim()
				});
			} else if (action === "delete-comment") {
				if (!window.confirm("Delete this reply?")) return;
				result = await supabaseClient.from("comments").delete().eq("id", button.dataset.commentId).eq("user_id", userId);
			} else if (action === "report-comment") {
				const reason = window.prompt("Why are you reporting this reply? (At least 5 characters)");
				if (reason === null) return;
				if (reason.trim().length < 5) throw new Error("Please provide a reason of at least 5 characters.");
				result = await supabaseClient.from("content_reports").insert({
					reporter_id: userId, comment_id: button.dataset.commentId, reported_user_id: post.comments.find((comment) => comment.id === button.dataset.commentId)?.userId, reason: reason.trim()
				});
			}
			if (result.error) throw result.error;
			if (action === "report-post") setFeedMessage("Report sent to the RTT moderation team.", true);
			if (activeView === "feed") await loadPosts();
			else await showView(activeView);
		} catch (error) {
			setFeedMessage(`Could not update that post: ${errorMessage(error, "Please try again.")}`);
			button.disabled = false;
		}
	}

	async function handleCommentSubmit(event) {
		if (!event.target.matches(".comment-form")) return;
		event.preventDefault();
		const form = event.target;
		const content = String(new FormData(form).get("comment") || "").trim();
		if (!content || content.length > 240) return;
		const button = form.querySelector('button[type="submit"]');
		button.disabled = true;
		form.querySelector(".comment-form-status").textContent = "";
		try {
			const imageFile = form.elements.image.files[0];
			const imageUrl = imageFile ? await uploadImage(imageFile, "comments") : null;
			const { error } = await supabaseClient.from("comments").insert({
				post_id: form.dataset.postId,
				user_id: userId,
				display_name: displayName,
				content,
				image_url: imageUrl,
				parent_comment_id: new FormData(form).get("parentId") || null
			});
			if (error) throw error;
			setFeedMessage("");
			if (activeView === "feed") await loadPosts();
			else await showView(activeView);
		} catch (error) {
			const missingPhotoColumn = error?.code === "42703" && /image_url/i.test(error.message || "");
			if (missingPhotoColumn) console.error("RTT comment-photo schema is missing comments.image_url.", error);
			const message = missingPhotoColumn
				? "Supabase has not been upgraded for comment photos. Run the updated supabase-schema.sql in the SQL Editor."
				: errorMessage(error, "Please try again.");
			form.querySelector(".comment-form-status").textContent = message;
			setFeedMessage(`Could not add your reply: ${message}`);
			button.disabled = false;
		}
	}

	function handleCommentImageChange(event) {
		const input = event.target.closest('.comment-form input[name="image"]');
		if (!input) return;
		const form = input.closest(".comment-form");
		const preview = form.querySelector(".comment-image-preview");
		const clearButton = form.querySelector(".comment-image-clear");
		const file = input.files[0];
		if (!file) return;
		const clearPreview = () => {
			if (preview.dataset.objectUrl) URL.revokeObjectURL(preview.dataset.objectUrl);
			preview.removeAttribute("src");
			delete preview.dataset.objectUrl;
			preview.hidden = true;
			clearButton.hidden = true;
		};
		if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.type)) {
			input.value = "";
			clearPreview();
			form.querySelector(".comment-form-status").textContent = "Choose a JPG, PNG, WebP, or GIF image.";
			setFeedMessage("Choose a JPG, PNG, WebP, or GIF image.");
			return;
		}
		if (file.size > 5 * 1024 * 1024) {
			input.value = "";
			clearPreview();
			form.querySelector(".comment-form-status").textContent = "Images must be 5 MB or smaller.";
			setFeedMessage("Images must be 5 MB or smaller.");
			return;
		}
		if (preview.dataset.objectUrl) URL.revokeObjectURL(preview.dataset.objectUrl);
		preview.dataset.objectUrl = URL.createObjectURL(file);
		preview.src = preview.dataset.objectUrl;
		preview.hidden = false;
		clearButton.hidden = false;
		form.querySelector(".comment-form-status").textContent = "";
		setFeedMessage("");
	}

	function setAuthMode(mode) {
		const isSignup = mode === "signup";
		document.getElementById("signup-name-field").hidden = !isSignup;
		document.getElementById("display-name").required = isSignup;
		document.getElementById("password").autocomplete = isSignup ? "new-password" : "current-password";
		document.querySelectorAll(".auth-tab").forEach((tab) => {
			const active = tab.dataset.mode === mode;
			tab.classList.toggle("active", active);
			tab.setAttribute("aria-selected", String(active));
		});
		document.getElementById("auth-panel").setAttribute("aria-labelledby", `${mode}-tab`);
		document.getElementById("auth-submit").innerHTML = `${isSignup ? "Create account" : "Log in"} <span aria-hidden="true">↗</span>`;
		setJoinMessage(isSignup
			? "Create an account to join your community."
			: "Log in or create an account to join your community.");
	}

	let openingUserId = null;
	async function openMemberSpace(user) {
		if (!user || userId === user.id || openingUserId === user.id) return;
		openingUserId = user.id;
		try {
			const { data: profile, error } = await supabaseClient
				.from("profiles")
				.select("id,display_name,username,avatar_url,cover_url,bio,courses,year_level,points,is_admin,discoverable,notifications_enabled,settings")
				.eq("id", user.id)
				.maybeSingle();
			if (error) throw error;
			if (!profile) throw new Error("Your profile is missing. Ask the site owner to run supabase-schema.sql in the Supabase SQL Editor.");
			enterCommunity(user, profile);
		} catch (error) {
			setJoinMessage(errorMessage(error, "Could not load your profile."));
		} finally {
			openingUserId = null;
		}
	}

	async function start() {
		document.getElementById("today-label").textContent = new Intl.DateTimeFormat(undefined, {
			weekday: "long",
			month: "long",
			day: "numeric"
		}).format(new Date()).toUpperCase();
		document.getElementById("year-label").textContent = String(new Date().getFullYear());
		document.getElementById("join-form").addEventListener("submit", handleJoinSubmit);
		document.querySelectorAll(".auth-tab").forEach((tab) => {
			tab.addEventListener("click", () => setAuthMode(tab.dataset.mode));
		});
		postForm.addEventListener("submit", handleCreatePost);
		postForm.addEventListener("change", handlePostImageChange);
		document.getElementById("clear-post-image").addEventListener("click", () => {
			clearPostImageSelection();
			setFeedMessage("");
		});
		feed.addEventListener("click", handlePostAction);
		feed.addEventListener("submit", handleCommentSubmit);
		feed.addEventListener("change", handleCommentImageChange);
		featureView.addEventListener("click", handleFeatureAction);
		featureView.addEventListener("submit", handleFeatureSubmit);
		featureView.addEventListener("change", handleCommentImageChange);
		featureView.addEventListener("change", handlePreferencePreview);
		featureView.addEventListener("keydown", handleMessageKeydown);
		featureView.addEventListener("input", handleMessageInput);
		featureView.addEventListener("focusout", handleMessageComposerFocusout);
		document.querySelectorAll("[data-view]").forEach((button) => {
			button.addEventListener("click", () => void showView(button.dataset.view));
		});
		filterButtons.forEach((button) => button.addEventListener("click", () => setFilter(button.dataset.filter, button)));
		searchInput.addEventListener("input", () => {
			if (activeView === "feed") renderFeed();
		});
		searchInput.addEventListener("keydown", (event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				void searchDirectory(searchInput.value, "all");
			}
		});
		document.getElementById("sort-select").addEventListener("change", renderFeed);
		document.getElementById("order-select").addEventListener("change", renderFeed);
		document.getElementById("poll-enabled").addEventListener("change", (event) => {
			document.getElementById("poll-fields").hidden = !event.target.checked;
		});
		document.getElementById("add-poll-option").addEventListener("click", () => {
			const fields = document.querySelector(".poll-option-fields");
			if (fields.children.length >= 6) {
				setFeedMessage("Polls can have up to six options.");
				return;
			}
			const input = makeElement("input", "poll-option");
			input.type = "text";
			input.maxLength = 80;
			input.placeholder = `Option ${fields.children.length + 1}`;
			input.setAttribute("aria-label", `Poll option ${fields.children.length + 1}`);
			fields.append(input);
		});
		document.getElementById("sign-out").addEventListener("click", async () => {
			if (!window.confirm("Sign out of your RTT account?")) return;
			const { error } = await supabaseClient.auth.signOut();
			if (error) setFeedMessage(`Could not sign out: ${errorMessage(error, "Please try again.")}`);
		});
		applyDevicePreferences();

		if (!hasConfig || !window.supabase?.createClient) {
			document.getElementById("join-status").textContent = "Supabase isn’t configured yet. The site owner needs to add the project URL and publishable key in supabase-config.js.";
			return;
		}

		supabaseClient = window.supabase.createClient(config.url, config.anonKey);
		try {
			supabaseClient.auth.onAuthStateChange((event, session) => {
				if (event === "SIGNED_IN" && session?.user) {
					window.setTimeout(() => void openMemberSpace(session.user), 0);
				}
				if (event === "SIGNED_OUT") {
					clearPostImageSelection();
					userId = null;
					displayName = null;
					signedInEmail = "";
					currentProfile = null;
					followingIds.clear();
					bookmarkIds.clear();
					if (refreshTimer) clearInterval(refreshTimer);
					refreshTimer = null;
					if (realtimeSubscription) void supabaseClient.removeChannel(realtimeSubscription);
					realtimeSubscription = null;
					document.getElementById("app-shell").hidden = true;
					document.getElementById("join-screen").hidden = false;
					setJoinMessage("You’ve signed out.", true);
				}
			});
			const { data, error } = await supabaseClient.auth.getSession();
			if (error) throw error;
			if (data.session?.user) await openMemberSpace(data.session.user);
		} catch (error) {
			setJoinMessage(errorMessage(error, "Could not restore your session."));
		}
	}

	void start();
})();