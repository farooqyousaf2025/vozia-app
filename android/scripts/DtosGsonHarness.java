import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.voiza.app.data.mapper.GameMappersKt;
import com.voiza.app.data.mapper.MappersKt;
import com.voiza.app.data.mapper.PkMappersKt;
import com.voiza.app.data.mapper.QuestMappersKt;
import com.voiza.app.data.remote.dto.*;
import com.voiza.app.domain.model.CheckInResult;
import com.voiza.app.domain.model.CheckInState;
import com.voiza.app.domain.model.DailyQuest;
import com.voiza.app.domain.model.PkBattle;
import com.voiza.app.domain.model.PkSettings;
import com.voiza.app.domain.model.PkSide;
import com.voiza.app.domain.model.PkStatus;
import com.voiza.app.domain.model.QuestsToday;
import com.voiza.app.domain.model.GameHistoryRow;
import com.voiza.app.domain.model.EmojiCatalogue;
import com.voiza.app.domain.model.EmojiOption;
import com.voiza.app.domain.model.GameSession;
import com.voiza.app.domain.model.GamesKt;
import com.voiza.app.domain.model.LudoBoard;
import com.voiza.app.domain.model.LudoSeat;
import com.voiza.app.domain.model.QuizBoard;
import com.voiza.app.domain.model.TicTacToeBoard;
import com.voiza.app.domain.model.GiftEffectKind;
import com.voiza.app.domain.model.EntryRide;
import com.voiza.app.domain.model.Gift;
import com.voiza.app.domain.model.GiftAnimationFormat;
import com.voiza.app.domain.model.GiftCatalogue;
import com.voiza.app.domain.model.GiftCategoryOption;
import com.voiza.app.domain.model.Leaderboard;
import com.voiza.app.domain.model.ModelsKt;
import com.voiza.app.domain.model.MiniUser;
import com.voiza.app.domain.model.ProfileFrame;
import com.voiza.app.domain.model.RankBoard;
import com.voiza.app.domain.model.RankRow;
import com.voiza.app.domain.model.UserJoinedEvent;
import com.voiza.app.domain.model.UserRank;
import com.voiza.app.domain.model.Room;
import com.voiza.app.domain.model.RoomProfileEvent;
import com.voiza.app.domain.model.RoomType;
import com.voiza.app.domain.model.SeatPolicy;
import com.voiza.app.domain.model.StoreItem;
import com.voiza.app.domain.model.StoreItemKind;
import com.voiza.app.domain.model.StorePurchase;
import com.voiza.app.domain.model.StoreSnapshot;
import com.voiza.app.domain.model.RoomLikeEvent;
import com.voiza.app.domain.model.ThemeChangedEvent;
import com.voiza.app.domain.model.RoomThemeOption;
import com.voiza.app.domain.model.ThemeCatalogue;

import java.nio.file.Files;
import java.nio.file.Paths;

/**
 * Deserialises real Voiza server payloads with the app's own compiled DTO classes and
 * runs them through the app's own mappers, so wire-shape mismatches surface here instead
 * of as an NPE on a device.
 *
 * Fixtures come from backend/scripts/capture-wire-fixtures.cjs. Gson builds Kotlin data
 * classes through UnsafeAllocator, so `= emptyList()` defaults never run and an absent
 * key stays null — which is exactly the class of bug this catches.
 *
 * Run through android/scripts/run-dto-harness.sh (needs a built debug APK first, because
 * it compiles against app/build/tmp/kotlin-classes/debug).
 */
public class DtosGsonHarness {
    static final Gson G = new Gson();
    static int pass = 0;
    static int fail = 0;

    interface Body { void run() throws Exception; }

    static void t(String name, Body body) {
        try {
            body.run();
            System.out.println("PASS  " + name);
            pass++;
        } catch (Throwable e) {
            Throwable root = e;
            while (root.getCause() != null) root = root.getCause();
            String m = root.getMessage() == null ? root.toString() : root.getMessage().replace('\n', ' ');
            System.out.println("FAIL  " + name + "  ->  " + root.getClass().getSimpleName() + ": " + trim(m));
            fail++;
        }
    }

    static String trim(String s) { return s.length() > 180 ? s.substring(0, 180) + "..." : s; }

    static JsonObject body(JsonObject doc, String key) { return doc.getAsJsonObject(key).getAsJsonObject("body"); }

    static JsonElement last(JsonObject doc, String event) {
        JsonArray a = doc.getAsJsonArray(event);
        if (a == null || a.size() == 0) throw new IllegalStateException("fixture has no '" + event + "' event");
        return a.get(a.size() - 1);
    }

    /**
     * A rung the phone is about to paint. The client never derives a level, so everything a
     * badge depends on has to arrive intact: a name to show, art that resolves through the
     * same asset-URL rule as gift art, and an accent the parser can read without crashing.
     */
    static void checkRung(UserRank rung, String where) {
        if (rung.getLevel() < 0) throw new IllegalStateException(where + " sent a negative level: " + rung.getLevel());
        String name = rung.getName();
        if (name == null || name.trim().isEmpty()) {
            throw new IllegalStateException(where + " sent a rung nobody can name");
        }
        String badge = rung.getBadge();
        if (badge != null && !badge.startsWith("/") && !badge.startsWith("https://")) {
            throw new IllegalStateException(where + " badge is not an asset URL: " + badge);
        }
        String accent = rung.getAccent();
        if (accent != null && !accent.matches("#[0-9a-fA-F]{6}")) {
            throw new IllegalStateException(where + " accent is not #rrggbb: " + accent);
        }
    }

    /** The session envelope one captured engine run left behind for a game key. */
    static GameSessionDto capturedSession(JsonObject doc, String key) {
        return G.fromJson(doc.getAsJsonObject("games").getAsJsonObject(key)
                .getAsJsonObject("read"), GameSessionEnvelope.class).getSession();
    }

    /**
     * A ring the phone is about to draw around an avatar. The art is a PNG with a transparent
     * middle, so it has to be a loadable URL — a ring the client guesses from `key` would be a
     * broken path, and a blank name would leave the shop row unreadable to a screen reader.
     */
    static void checkFrame(ProfileFrame frame, String where) {
        if (frame.getKey().isEmpty()) throw new IllegalStateException(where + " carried a ring with no key");
        if (frame.getName().isEmpty()) throw new IllegalStateException(where + " carried a ring with no name");
        if (!frame.getArt().startsWith("/") && !frame.getArt().startsWith("https://")) {
            throw new IllegalStateException(where + " ring art is not an asset URL: " + frame.getArt());
        }
        String accent = frame.getAccent();
        if (accent != null && !accent.matches("#[0-9a-fA-F]{6}")) {
            throw new IllegalStateException(where + " ring accent is not #rrggbb: " + accent);
        }
    }

    /**
     * The ride an account arrives with, as the room will actually receive it.
     *
     * `url` and `format` are this object's key names — the shop row spells the same two facts `art`
     * and `animationFormat` — so a mapper that reused the shop shape would hand every device a
     * null URL and the room would silently stop playing arrivals. A negative hold is impossible at
     * the schema, so it is a mapping bug; 0 is a legal answer and must stay 0.
     */
    static void checkRide(com.voiza.app.domain.model.EntryRide ride, String where) {
        if (ride.getKey().isEmpty()) throw new IllegalStateException(where + " carried a ride with no key");
        if (ride.getName().isEmpty()) throw new IllegalStateException(where + " carried a ride with no name");
        String url = ride.getUrl();
        if (!url.startsWith("/") && !url.startsWith("https://")) {
            throw new IllegalStateException(where + " ride url is not an asset URL: " + url);
        }
        if (ride.getFormat() == null) {
            throw new IllegalStateException(where + " ride named no renderer: " + url);
        }
        if (ride.getDurationMs() < 0) {
            throw new IllegalStateException(where + " ride holds the screen for " + ride.getDurationMs() + " ms");
        }
    }

    /** A shop row the assertions below need by name rather than by index: the capture's order is the server's. */
    static StoreItem rideByKey(StoreSnapshot shop, String key) {
        for (StoreItem item : shop.getItems()) {
            if (item.getKind() == StoreItemKind.RIDE && item.getKey().equals(key)) return item;
        }
        throw new IllegalStateException("the capture sold no ride named " + key);
    }

    public static void main(String[] args) throws Exception {
        String restPath = args.length > 0 ? args[0] : "fixtures/wire-rest.json";
        String sockPath = args.length > 1 ? args[1] : "fixtures/wire-socket.json";
        String gamesPath = args.length > 2 ? args[2] : "fixtures/wire-games.json";
        JsonObject rest = JsonParser.parseString(new String(Files.readAllBytes(Paths.get(restPath)))).getAsJsonObject();
        JsonObject sock = JsonParser.parseString(new String(Files.readAllBytes(Paths.get(sockPath)))).getAsJsonObject();
        JsonObject gamesDoc = JsonParser.parseString(new String(Files.readAllBytes(Paths.get(gamesPath)))).getAsJsonObject();

        System.out.println("--- REST envelopes the app parses ---");

        t("GET /api/rooms        -> RoomsResponse -> RoomSummaryDto.toDomain", () -> {
            RoomsResponse rr = G.fromJson(body(rest, "rooms"), RoomsResponse.class);
            for (RoomSummaryDto d : rr.getRooms()) MappersKt.toDomain(d);
        });

        t("GET /api/rooms/:id    -> RoomDetailResponse -> room+seats+audience+chat+handRaises", () -> {
            RoomDetailResponse dr = G.fromJson(body(rest, "detail"), RoomDetailResponse.class);
            MappersKt.toDomain(dr.getRoom());
            for (SeatDto s : dr.getSeats()) MappersKt.toDomain(s);
            for (MiniUserDto u : dr.getAudience()) MappersKt.toDomain(u);
            for (ChatMessageDto c : dr.getChat()) MappersKt.toDomain(c);
            // Absent key => null (Gson never runs the Kotlin default), so callers map null-safely.
            if (dr.getHandRaises() != null) {
                for (ParticipantDto p : dr.getHandRaises()) {
                    if (p.getUser() != null) MappersKt.toDomain(p.getUser());
                }
            }
        });

        t("POST join             -> JoinRoomResponse -> room+seats+audience+livekit", () -> {
            JoinRoomResponse jr = G.fromJson(body(rest, "join"), JoinRoomResponse.class);
            MappersKt.toDomain(jr.getRoom());
            for (SeatDto s : jr.getSeats()) MappersKt.toDomain(s);
            for (MiniUserDto u : jr.getAudience()) MappersKt.toDomain(u);
            MappersKt.toDomain(jr.getLivekit());
        });

        t("POST /api/rooms       -> RoomEnvelope -> room (create has no seats key)", () -> {
            RoomEnvelope re = G.fromJson(body(rest, "create"), RoomEnvelope.class);
            MappersKt.toDomain(re.getRoom());
        });

        t("GET /api/rooms?sort&search&language -> discovery rows parse", () -> {
            RoomsResponse rr = G.fromJson(body(rest, "discovery"), RoomsResponse.class);
            for (RoomSummaryDto d : rr.getRooms()) {
                if (MappersKt.toDomain(d).getId().isEmpty()) {
                    throw new IllegalStateException("discovery row lost its id");
                }
            }
        });

        t("GET /api/rooms/mine   -> the host's own rows parse", () -> {
            RoomsResponse rr = G.fromJson(body(rest, "myRooms"), RoomsResponse.class);
            for (RoomSummaryDto d : rr.getRooms()) MappersKt.toDomain(d);
        });

        t("GET /api/rooms/quick-join -> RoomEnvelope when the server has a room to offer", () -> {
            JsonObject env = body(rest, "quickJoin");
            // 404 with no body is a real answer (nothing joinable); a room, when present, must parse.
            if (env.has("room") && !env.get("room").isJsonNull()) {
                Room room = MappersKt.toDomain(G.fromJson(env.get("room"), RoomDto.class));
                if (room.getType() != RoomType.PUBLIC) {
                    throw new IllegalStateException("quick join offered a " + room.getType() + " room");
                }
            }
        });

        t("PATCH /api/rooms/:id  -> room carries the language, region and rules the host set", () -> {
            Room room = MappersKt.toDomain(G.fromJson(body(rest, "update").getAsJsonObject("room"), RoomDto.class));
            if (!"en".equals(room.getLanguage())) {
                throw new IllegalStateException("edited language came back as " + room.getLanguage());
            }
            if (!"BD".equals(room.getRegion())) {
                throw new IllegalStateException("edited region came back as " + room.getRegion());
            }
            if (room.getRules() == null || !room.getRules().contains("mic off")) {
                throw new IllegalStateException("edited rules came back as " + room.getRules());
            }
        });

        t("GET /api/wallet       -> WalletResponse -> transactions+stats", () -> {
            WalletResponse w = G.fromJson(body(rest, "wallet"), WalletResponse.class);
            MappersKt.toDomain(w);
            for (TransactionDto tr : w.getTransactions()) MappersKt.toDomain(tr);
        });

        t("GET /api/gifts        -> GiftsResponse -> GiftDto.toDomain", () -> {
            GiftsResponse gr = G.fromJson(body(rest, "gifts"), GiftsResponse.class);
            for (GiftDto gd : gr.getGifts()) MappersKt.toDomain(gd);
        });

        // The categories array (backend migration 0025) is what the gift panel's tabs are now built
        // from. The two cases below are the whole risk surface of the change: a payload that carries
        // shelves, and one that does not — and the second is the Gson-Unsafe trap the project rule
        // exists for, so it is asserted on the absent key rather than on an explicit null.
        t("catalogue WITH categories decodes into shelves with key/name/sortOrder", () -> {
            GiftsResponse gr = G.fromJson("{\"gifts\":[],"
                    + "\"categories\":["
                    + "{\"key\":\"ROSE\",\"name\":\"Roses\",\"sortOrder\":10,\"gifts\":1},"
                    + "{\"key\":\"SPECIAL\",\"name\":\"Special\",\"sortOrder\":20,\"gifts\":8}]}",
                    GiftsResponse.class);
            if (gr.getCategories() == null || gr.getCategories().size() != 2) {
                throw new IllegalStateException("categories array did not decode into 2 shelves");
            }
            GiftCatalogue cat = MappersKt.toDomain(gr);
            java.util.List<GiftCategoryOption> shelves = cat.getCategories();
            if (shelves.size() != 2) throw new IllegalStateException("expected 2 domain shelves, got " + shelves.size());
            if (!"ROSE".equals(shelves.get(0).getKey())) {
                throw new IllegalStateException("first shelf key is " + shelves.get(0).getKey());
            }
            if (!"Roses".equals(shelves.get(0).getName())) {
                throw new IllegalStateException("the operator's label did not survive: " + shelves.get(0).getName());
            }
            if (shelves.get(0).getSortOrder() != 10 || shelves.get(1).getSortOrder() != 20) {
                throw new IllegalStateException("sortOrder did not survive the mapper");
            }
            if (!"SPECIAL".equals(shelves.get(1).getKey())) {
                throw new IllegalStateException("second shelf key is " + shelves.get(1).getKey());
            }
            // A shelf row with no key cannot match a gift or label a tab, so it is dropped, not guessed.
            GiftCategoryOption nameless = MappersKt.toDomain(
                    G.fromJson("{\"key\":\"\",\"name\":\"Nobody\"}", GiftCategoryDto.class));
            if (nameless != null) throw new IllegalStateException("a shelf with no key must map to null");
            GiftCategoryOption unnamed = MappersKt.toDomain(
                    G.fromJson("{\"key\":\"LUXURY_BOX\"}", GiftCategoryDto.class));
            if (unnamed == null || !"Luxury box".equals(unnamed.getName())) {
                throw new IllegalStateException("a named-less shelf should read as the old cosmetic label");
            }
        });

        t("catalogue WITHOUT categories key decodes null and falls back to derived tabs", () -> {
            GiftsResponse gr = G.fromJson("{\"gifts\":["
                    + "{\"id\":\"1\",\"name\":\"Rose\",\"iconUrl\":\"/i.png\",\"diamondPrice\":1,\"rCoinValue\":1,\"category\":\"ROSE\"},"
                    + "{\"id\":\"2\",\"name\":\"Car\",\"iconUrl\":\"/i.png\",\"diamondPrice\":50,\"rCoinValue\":50,\"category\":\"SPECIAL\"}]}",
                    GiftsResponse.class);
            if (gr.getCategories() != null) {
                throw new IllegalStateException("an absent categories key must stay null, not take the Kotlin default");
            }
            GiftCatalogue cat = MappersKt.toDomain(gr);
            if (!cat.getCategories().isEmpty()) {
                throw new IllegalStateException("no shelves from the server must map to an empty shelf list");
            }
            java.util.List<GiftCategoryOption> tabs = ModelsKt.giftCategoryTabs(cat.getCategories(), cat.getGifts());
            if (tabs.size() != 2) {
                throw new IllegalStateException("the fallback should derive one tab per category, got " + tabs.size());
            }
            if (!"ROSE".equals(tabs.get(0).getKey()) || !"SPECIAL".equals(tabs.get(1).getKey())) {
                throw new IllegalStateException("the fallback lost the catalogue's first-appearance order");
            }
            // The fallback labels exactly as the panel always did — derived from the raw string.
            if (!"Rose".equals(tabs.get(0).getName())) {
                throw new IllegalStateException("fallback tab label is " + tabs.get(0).getName());
            }
            // And the key is what filtering uses, so the existing giftCategory state still selects rows.
            if (cat.getGifts().stream().noneMatch(g -> "ROSE".equals(g.getCategory()))) {
                throw new IllegalStateException("tab keys no longer match any gift's category");
            }
        });

        t("tabs follow server shelves: empty shelf dropped, order kept, unmatched gift still visible", () -> {
            GiftsResponse gr = G.fromJson("{\"gifts\":["
                    + "{\"id\":\"1\",\"name\":\"Rose\",\"iconUrl\":\"/i.png\",\"diamondPrice\":1,\"rCoinValue\":1,\"category\":\"ROSE\"},"
                    + "{\"id\":\"2\",\"name\":\"Mystery\",\"iconUrl\":\"/i.png\",\"diamondPrice\":9,\"rCoinValue\":9,\"category\":\"MYSTERY\"}],"
                    + "\"categories\":["
                    + "{\"key\":\"ROSE\",\"name\":\"Roses\",\"sortOrder\":10,\"gifts\":1},"
                    + "{\"key\":\"SPECIAL\",\"name\":\"Special\",\"sortOrder\":20,\"gifts\":0},"
                    + "{\"key\":\"EVENT\",\"name\":\"Events\",\"sortOrder\":30,\"gifts\":1}]}",
                    GiftsResponse.class);
            GiftCatalogue cat = MappersKt.toDomain(gr);
            java.util.List<GiftCategoryOption> tabs = ModelsKt.giftCategoryTabs(cat.getCategories(), cat.getGifts());
            if (tabs.size() != 1 || !"ROSE".equals(tabs.get(0).getKey())) {
                throw new IllegalStateException("only the shelf with a loaded gift may render a tab");
            }
            // The gift filed under a key no shelf ships is NOT dropped — it stays for "All".
            if (cat.getGifts().size() != 2) {
                throw new IllegalStateException("a gift outside the shelf list was dropped from the catalogue");
            }
            // A tab the server shipped but that is empty renders nothing; its gifts would have been
            // unreachable, so the strip keeping it out is the whole point of the filter.
            if (cat.getCategories().size() != 3) {
                throw new IllegalStateException("the shelf list itself must not be filtered at mapping time");
            }
        });

        t("the captured /api/gifts fixture still parses through the shelf-aware path", () -> {
            GiftsResponse gr = G.fromJson(body(rest, "gifts"), GiftsResponse.class);
            GiftCatalogue cat = MappersKt.toDomain(gr);
            java.util.List<GiftCategoryOption> tabs = ModelsKt.giftCategoryTabs(cat.getCategories(), cat.getGifts());
            if (gr.getCategories() == null && !cat.getCategories().isEmpty()) {
                throw new IllegalStateException("absent shelves must map to an empty list");
            }
            // Whatever shape this capture has, a catalogue with rows must never end up with no way
            // to reach them: either the server's shelves or the derived fallback fills the strip.
            if (!cat.getGifts().isEmpty() && tabs.isEmpty()) {
                throw new IllegalStateException("a non-empty catalogue lost every tab");
            }
            for (GiftCategoryOption tab : tabs) {
                if (tab.getKey().isEmpty() || tab.getName().isEmpty()) {
                    throw new IllegalStateException("a tab reached the panel with no key or no label");
                }
            }
        });

        t("GET withdrawals       -> WithdrawalDto.toDomain", () -> {
            JsonObject el = body(rest, "withdrawals");
            JsonArray arr = el.has("withdrawals") ? el.getAsJsonArray("withdrawals") : new JsonArray();
            for (JsonElement e : arr) MappersKt.toDomain(G.fromJson(e, WithdrawalDto.class));
        });

        t("GET users/top         -> LeaderboardResponse -> RankRow rows", () -> {
            Leaderboard board = MappersKt.toDomain(G.fromJson(body(rest, "boardReceivers"), LeaderboardResponse.class));
            if (board.getWindow() == null || board.getWindow().isEmpty()) {
                throw new IllegalStateException("board lost its window key");
            }
            if (board.getBoard() != RankBoard.RECEIVERS) {
                throw new IllegalStateException("host board read as " + board.getBoard());
            }
            for (RankRow row : board.getRows()) {
                if (row.getUser().getId().isEmpty()) throw new IllegalStateException("rank row lost its user id");
                if (row.getEarned() < 0) throw new IllegalStateException("negative earnings on the board");
            }
        });

        t("GET users/top?role=senders -> RankBoard.SENDERS", () -> {
            Leaderboard board = MappersKt.toDomain(G.fromJson(body(rest, "boardSenders"), LeaderboardResponse.class));
            if (board.getBoard() != RankBoard.SENDERS) {
                throw new IllegalStateException("spend board read as " + board.getBoard());
            }
        });

        System.out.println("\n--- store, worn decoration and the account that carries it ---");

        t("GET /api/store        -> StoreSnapshot -> sellable rows + the caller's own holdings", () -> {
            StoreSnapshot shop = MappersKt.toDomain(
                    G.fromJson(body(rest, "store"), StoreResponse.class));
            if (shop.getItems().isEmpty()) throw new IllegalStateException("the shop sold nothing");
            java.util.Set<StoreItemKind> kinds = new java.util.HashSet<>();
            for (StoreItem item : shop.getItems()) {
                kinds.add(item.getKind());
                if (item.getPriceDiamonds() <= 0) {
                    throw new IllegalStateException(item.getKey() + " is on sale with no price");
                }
                // A theme decorates a room, so an account can never wear one.
                if (item.getEquipped() && item.getKind() == StoreItemKind.THEME) {
                    throw new IllegalStateException("a theme was reported as worn by the account");
                }
                if (item.getPeriodDays() == null && item.getExpiresAt() != null) {
                    throw new IllegalStateException(item.getKey() + " is permanent but has an expiry");
                }
                if (!item.getArt().startsWith("/") && !item.getArt().startsWith("https://")) {
                    throw new IllegalStateException(item.getKey() + " art is not an asset URL: " + item.getArt());
                }
            }
            // Every kind the shop screen has a tab for must exist, or a tab is a dead end.
            if (!kinds.containsAll(java.util.Arrays.asList(StoreItemKind.values()))) {
                throw new IllegalStateException("the capture sold only " + kinds);
            }
            for (com.voiza.app.domain.model.OwnedStoreItem owned : shop.getOwned()) {
                if (owned.getKey().isEmpty()) throw new IllegalStateException("a holding lost its key");
            }
            // A ride row says two things no other catalogue does, and the shop's Arrivals tab has
            // to route on exactly those: which renderer opens the file, and how long the room hands
            // it the screen. Neither may be re-derived from the file extension.
            StoreItem lottie = rideByKey(shop, "ride-confetti");
            if (lottie.getAnimationFormat() != GiftAnimationFormat.LOTTIE) {
                throw new IllegalStateException("ride-confetti lost its declared LOTTIE format: " + lottie.getAnimationFormat());
            }
            if (lottie.getDurationMs() != 4000) {
                throw new IllegalStateException("ride-confetti lost its 4000 ms hold: " + lottie.getDurationMs());
            }
            // The capture wears this one, so the tab is reading its own highlighted row off the same
            // list — an `equipped` flag the server never sends would leave the shop unable to say
            // "you are arriving with this".
            if (!lottie.getEquipped()) {
                throw new IllegalStateException("the capture equipped a ride the shop then reported as unworn");
            }
            // An MP4 with a hold of 0 is the operator's answer "play the clip for its own length", and
            // the shipped seeds are all Lottie, so this shape is built here rather than hoped for in a
            // capture: 0 has to survive mapping as 0. Reading it as "nothing declared" and substituting
            // a short default would cut a full-screen video in half; reading it as "never ends" would
            // strand the room.
            StoreItemDto videoDto = G.fromJson("{\"kind\":\"RIDE\",\"key\":\"ride-video\",\"name\":\"Curtain Call\","
                    + "\"art\":\"/rides/curtain.mp4\",\"priceDiamonds\":3000,\"periodDays\":30,"
                    + "\"animationFormat\":\"MP4\",\"durationMs\":0,"
                    + "\"owned\":false,\"expiresAt\":null,\"equipped\":false}", StoreItemDto.class);
            StoreItem video = MappersKt.toDomainOrNull(videoDto);
            if (video == null) throw new IllegalStateException("a ride row with art and a price mapped away");
            if (video.getAnimationFormat() != GiftAnimationFormat.MP4) {
                throw new IllegalStateException("a declared MP4 ride mapped as " + video.getAnimationFormat());
            }
            if (video.getDurationMs() != 0) {
                throw new IllegalStateException("a declared 0 ms hold became " + video.getDurationMs());
            }
            // And the row a backend predating migration 0026 sends: neither key at all, so Gson leaves
            // both null through Unsafe and the mapper's fallbacks are what the tab routes on.
            StoreItem bare = MappersKt.toDomainOrNull(G.fromJson(
                    "{\"kind\":\"RIDE\",\"key\":\"ride-bare\",\"name\":\"Old Arrival\","
                            + "\"art\":\"/rides/old.json\",\"priceDiamonds\":1000,\"periodDays\":30}",
                    StoreItemDto.class));
            if (bare == null) throw new IllegalStateException("a ride row with art and a price mapped away");
            if (bare.getAnimationFormat() != GiftAnimationFormat.LOTTIE) {
                throw new IllegalStateException("an absent format did not fall back to LOTTIE: " + bare.getAnimationFormat());
            }
            if (bare.getDurationMs() != 0) {
                throw new IllegalStateException("an absent duration did not fall back to 0: " + bare.getDurationMs());
            }
        });

        t("ride store row WITHOUT animationFormat/durationMs decodes null on the DTO, not a default", () -> {
            // The regression this guards: a non-nullable Int/String for a key only one of the four
            // catalogues sends would crash every frame, theme and effect row on an older backend —
            // and a Kotlin `= 0` default would silently never run, because Gson builds via Unsafe.
            StoreItemDto dto = G.fromJson("{\"kind\":\"RIDE\",\"key\":\"ride-old\",\"name\":\"Old Arrival\","
                    + "\"art\":\"/rides/old.json\",\"priceDiamonds\":1000,\"periodDays\":30,"
                    + "\"owned\":false,\"expiresAt\":null,\"equipped\":false}", StoreItemDto.class);
            if (dto.getAnimationFormat() != null) throw new IllegalStateException("absent format was not null");
            if (dto.getDurationMs() != null) throw new IllegalStateException("absent durationMs was not null");
            StoreItem item = MappersKt.toDomainOrNull(dto);
            if (item.getKind() != StoreItemKind.RIDE) {
                throw new IllegalStateException("a RIDE row was dropped or mis-sorted: " + item.getKind());
            }
            if (item.getAnimationFormat() != GiftAnimationFormat.LOTTIE || item.getDurationMs() != 0) {
                throw new IllegalStateException("the mapper did not apply the ride fallbacks: "
                        + item.getAnimationFormat() + " / " + item.getDurationMs());
            }
        });

        t("a ride row with no art is dropped, not sold as an empty cinematic", () -> {
            // Key, name and art are what both the card and the buy call need; a ride nobody can
            // open is worse than no row at all, because buying it would appear to succeed.
            StoreItemDto dto = G.fromJson("{\"kind\":\"RIDE\",\"key\":\"ride-hollow\",\"name\":\"Hollow\","
                    + "\"priceDiamonds\":1000,\"animationFormat\":\"SVGA\",\"durationMs\":3000}", StoreItemDto.class);
            if (MappersKt.toDomainOrNull(dto) != null) {
                throw new IllegalStateException("a ride without a file still reached the shelf");
            }
        });

        t("store item WITH minVipLevel + recommended decodes both through DTO and mapper", () -> {
            StoreItemDto dto = G.fromJson("{\"kind\":\"FRAME\",\"key\":\"vip-ring\",\"name\":\"VIP Ring\","
                    + "\"art\":\"/frames/trace/frame-9.png\",\"priceDiamonds\":12000,"
                    + "\"minVipLevel\":5,\"recommended\":true}", StoreItemDto.class);
            if (dto.getMinVipLevel() == null || dto.getMinVipLevel() != 5) {
                throw new IllegalStateException("present minVipLevel did not decode as 5: " + dto.getMinVipLevel());
            }
            if (dto.getRecommended() == null || !dto.getRecommended()) {
                throw new IllegalStateException("present recommended did not decode as true: " + dto.getRecommended());
            }
            StoreItem item = MappersKt.toDomainOrNull(dto);
            if (item.getMinVipLevel() != 5 || !item.getRecommended()) {
                throw new IllegalStateException("the new fields did not survive the mapper");
            }
        });

        t("store item WITHOUT minVipLevel/recommended falls back to 0/false (the Unsafe rule)", () -> {
            // Gson builds via Unsafe, so an absent key is null on the DTO, not the Kotlin default.
            // The regression this guards: a non-nullable Int would crash; a non-nullable Boolean or
            // a mapper that skipped `?: 0` would silently read a pre-0024 backend as gated.
            StoreItemDto dto = G.fromJson("{\"kind\":\"FRAME\",\"key\":\"old-ring\",\"name\":\"Old Ring\","
                    + "\"art\":\"/frames/trace/frame-1.png\",\"priceDiamonds\":300}", StoreItemDto.class);
            if (dto.getMinVipLevel() != null) throw new IllegalStateException("absent minVipLevel was not null");
            if (dto.getRecommended() != null) throw new IllegalStateException("absent recommended was not null");
            StoreItem item = MappersKt.toDomainOrNull(dto);
            if (item.getMinVipLevel() != 0) {
                throw new IllegalStateException("absent minVipLevel did not fall back to 0: " + item.getMinVipLevel());
            }
            if (item.getRecommended()) throw new IllegalStateException("absent recommended did not fall back to false");
        });

        t("POST /api/store/purchase -> the row is owned and the envelope names the wallet that paid", () -> {
            StorePurchase bought = MappersKt.toDomain(
                    G.fromJson(body(rest, "storePurchase"), StorePurchaseResponse.class));
            if (bought.getItem() == null) throw new IllegalStateException("purchase response carried no item");
            if (!bought.getItem().getOwned()) {
                throw new IllegalStateException("the row was bought but the response says it is not owned");
            }
            if (bought.getUser() == null) throw new IllegalStateException("purchase carried no wallet");
            // The price came from the server's own row; the client only ever echoed kind+key.
            if (bought.getItem().getPriceDiamonds() <= 0) {
                throw new IllegalStateException("purchased row lost its price");
            }
        });

        t("POST /api/store/equip -> UserEnvelope carries the ring now worn", () -> {
            UserEnvelope env = G.fromJson(body(rest, "storeEquip"), UserEnvelope.class);
            com.voiza.app.domain.model.User user = MappersKt.toDomain(env.getUser());
            if (user.getProfileFrame() == null) {
                throw new IllegalStateException("equip returned an account wearing nothing");
            }
            checkFrame(user.getProfileFrame(), "POST /api/store/equip");
            // Equipping one kind never rewrites another, and this capture buys and wears a ride
            // before the frame call, so the echo has to still name that same ride. Null is only
            // allowed when the account itself wears none — the app must not guess a ride from the
            // catalogue for a member who bought nothing.
            com.voiza.app.domain.model.User account = MappersKt.toDomain(
                    G.fromJson(body(rest, "me"), UserEnvelope.class).getUser());
            if (user.getEntryRide() == null) {
                if (account.getEntryRide() != null) {
                    throw new IllegalStateException("an equip echo dropped the ride the account wears");
                }
            } else {
                checkRide(user.getEntryRide(), "POST /api/store/equip");
                if (!user.getEntryRide().equals(account.getEntryRide())) {
                    throw new IllegalStateException("a ring equip rewrote the ride the account wears: "
                            + user.getEntryRide());
                }
            }
        });

        t("POST /api/store/equip for a RIDE kind sends exactly kind+key and never a price", () -> {
            // The body the shop builds for a ride must be the same two fields the frame call uses;
            // the diamond amount is read by the server inside the transaction, not echoed by us.
            StoreItemBody body = new StoreItemBody(StoreItemKind.RIDE.name(), "ride-confetti");
            String json = G.toJson(body);
            if (!json.contains("\"RIDE\"")) throw new IllegalStateException("ride kind not sent: " + json);
            if (json.contains("rice")) throw new IllegalStateException("a price travelled to the server: " + json);
            if (!json.contains("ride-confetti")) throw new IllegalStateException("ride key missing: " + json);
        });

        t("GET /api/auth/me     -> the account ships the worn ring and the paid flourish", () -> {
            // Both were equipped by the capture before it read the account, so an absent
            // decoration here means an equip did not persist rather than "nothing is worn".
            com.voiza.app.domain.model.User me = MappersKt.toDomain(
                    G.fromJson(body(rest, "me"), UserEnvelope.class).getUser());
            if (me.getProfileFrame() == null) throw new IllegalStateException("account lost its worn ring");
            checkFrame(me.getProfileFrame(), "GET /api/auth/me");
            if (me.getEntryEffect() == null) throw new IllegalStateException("account lost its entry flourish");
            if (!me.getEntryEffect().startsWith("/") && !me.getEntryEffect().startsWith("https://")) {
                throw new IllegalStateException("flourish is not an asset URL: " + me.getEntryEffect());
            }
            // The account is where the app reads what its own member arrives with; the room gets the
            // same object on `room:user_joined`. Both spell the fields url/format, not art/kind.
            if (me.getEntryRide() == null) throw new IllegalStateException("account lost its worn ride");
            checkRide(me.getEntryRide(), "GET /api/auth/me");
            // Which renderer and how long are the seed's business, not the harness's — the check is
            // that the mapper repeats what this capture's own JSON says, field for field, because
            // those two fields are what picks the ride's player and when the room gets its screen back.
            JsonElement worn = body(rest, "me").get("user").getAsJsonObject().get("entryRide");
            if (worn == null || worn.isJsonNull()) {
                throw new IllegalStateException("the wire wore no ride but the account mapped one");
            }
            JsonObject written = worn.getAsJsonObject();
            if (!me.getEntryRide().getKey().equals(written.get("key").getAsString())) {
                throw new IllegalStateException("a ride's key was rewritten in mapping");
            }
            if (!me.getEntryRide().getUrl().equals(written.get("url").getAsString())) {
                throw new IllegalStateException("a ride's art was rewritten in mapping");
            }
            if (me.getEntryRide().getFormat() != GiftAnimationFormat.valueOf(written.get("format").getAsString())) {
                throw new IllegalStateException("a ride's declared renderer was rewritten: "
                        + me.getEntryRide().getFormat() + " vs the wire's " + written.get("format"));
            }
            if (me.getEntryRide().getDurationMs() != written.get("durationMs").getAsInt()) {
                throw new IllegalStateException("a ride's declared hold became " + me.getEntryRide().getDurationMs());
            }
        });

        t("account WITHOUT an entryRide reads as walking in quietly, never as a free default", () -> {
            // There is no free ride row and no fallback art in this app: a member who bought nothing,
            // whose copy lapsed or whose row was retired arrives as null. A client that invented a
            // ride here would play a full-screen takeover for someone who never paid for one.
            com.voiza.app.domain.model.User bareRide = MappersKt.toDomain(
                    G.fromJson("{\"user\":{\"id\":\"u1\",\"phone\":\"+15005550001\",\"username\":\"ana\","
                            + "\"userType\":\"USER\",\"status\":\"ACTIVE\",\"entryRide\":null}}",
                            UserEnvelope.class).getUser());
            if (bareRide.getEntryRide() != null) {
                throw new IllegalStateException("absent ride became " + bareRide.getEntryRide());
            }
            // A ride object that names a file nobody can open is dropped by the mapper, the same way
            // a ring without art is: the account then reads as owning nothing rather than as broken.
            com.voiza.app.domain.model.User hollow = MappersKt.toDomain(
                    G.fromJson("{\"user\":{\"id\":\"u1\",\"phone\":\"+15005550001\",\"username\":\"ana\","
                            + "\"userType\":\"USER\",\"status\":\"ACTIVE\","
                            + "\"entryRide\":{\"key\":\"ride-hollow\",\"name\":\"Hollow\","
                            + "\"format\":\"MP4\",\"durationMs\":5000}}}",
                            UserEnvelope.class).getUser());
            if (hollow.getEntryRide() != null) {
                throw new IllegalStateException("a ride with no url reached the profile: " + hollow.getEntryRide());
            }
        });

        t("equip response WITHOUT a ring reads as wearing nothing, never as a broken frame", () -> {
            // Gson leaves the key absent => null, and a mapper that invented a frame from the
            // account id would draw a ring nobody bought.
            com.voiza.app.domain.model.User bare = MappersKt.toDomain(
                    G.fromJson("{\"user\":{\"id\":\"u1\",\"phone\":\"+15005550001\",\"username\":\"ana\","
                            + "\"userType\":\"USER\",\"status\":\"ACTIVE\"}}", UserEnvelope.class).getUser());
            if (bare.getProfileFrame() != null) throw new IllegalStateException("absent frame became " + bare.getProfileFrame());
            if (bare.getEntryEffect() != null) throw new IllegalStateException("absent flourish became " + bare.getEntryEffect());
            // Absent, not the Kotlin null either: an account that never mentioned a ride owns none.
            if (bare.getEntryRide() != null) throw new IllegalStateException("absent ride became " + bare.getEntryRide());
        });

        System.out.println("\n--- daily quests and the check-in (migration 0020) ---");

        t("GET /api/quests       -> QuestsToday -> day + quests + this member's check-in", () -> {
            QuestsToday today = QuestMappersKt.toDomain(
                    G.fromJson(body(rest, "questsBefore"), QuestsTodayDto.class));
            if (today.getDate().isEmpty()) throw new IllegalStateException("the status carried no day");
            if (today.getResetTimezone().isEmpty()) {
                throw new IllegalStateException("the status carried no reset timezone");
            }
            if (today.getQuests().isEmpty()) throw new IllegalStateException("no quests were published");
            boolean sawCompleted = false;
            for (DailyQuest quest : today.getQuests()) {
                if (quest.getKey().isEmpty() || quest.getTitle().isEmpty()) {
                    throw new IllegalStateException("a quest lost its key or title");
                }
                if (quest.getTarget() <= 0) throw new IllegalStateException(quest.getKey() + " has no target");
                if (quest.getXpReward() <= 0) throw new IllegalStateException(quest.getKey() + " pays no XP");
                if (quest.getProgress() < 0 || quest.getFraction() < 0f || quest.getFraction() > 1f) {
                    throw new IllegalStateException(quest.getKey() + " has an impossible progress/fraction");
                }
                // XP is only ever awarded at completion, so a counter without it paying anything
                // means the mapper dropped a field the phone would print.
                if (!quest.getCompleted() && quest.getXpAwarded() != 0) {
                    throw new IllegalStateException(quest.getKey() + " reported XP before completing");
                }
                if (quest.getCompleted() && quest.getXpAwarded() > 0) sawCompleted = true;
            }
            // The capture sent gifts before reading this, so the gift quest must be finished; a
            // false here would mean progress was not recorded or the completed flag is not shipped.
            if (!sawCompleted) throw new IllegalStateException("no quest completed after gifts were sent");
            CheckInState checkIn = today.getCheckIn();
            if (checkIn == null) throw new IllegalStateException("the status carried no check-in");
            if (checkIn.getBaseXp() <= 0) throw new IllegalStateException("check-in pays nothing");
            if (checkIn.getMaxStreakDays() < 1) throw new IllegalStateException("the streak cap is below one day");
            if (checkIn.getNextRewardXp() < checkIn.getBaseXp()) {
                throw new IllegalStateException("the next check-in pays less than the base");
            }
        });

        t("POST /api/quests/checkin -> reward + status.done + the account that earned it", () -> {
            CheckInResult result = QuestMappersKt.toDomain(
                    G.fromJson(body(rest, "questsCheckIn"), CheckInResponseDto.class));
            if (result.getXpAwarded() <= 0) throw new IllegalStateException("check-in paid no XP");
            QuestsToday status = result.getStatus();
            if (status == null || status.getCheckIn() == null) {
                throw new IllegalStateException("the claim carried no status");
            }
            CheckInState checkIn = status.getCheckIn();
            if (!checkIn.getDone()) throw new IllegalStateException("the claim did not close today");
            if (checkIn.getAvailable()) throw new IllegalStateException("today is still claimable after claiming");
            if (checkIn.getStreakDay() < 1) throw new IllegalStateException("the streak did not start");
            // The paid reward is what the phone prints, so it must agree with the transaction.
            if (result.getXpAwarded() != checkIn.getXpAwardedToday()) {
                throw new IllegalStateException("paid " + result.getXpAwarded()
                        + " but the status says " + checkIn.getXpAwardedToday());
            }
        });

        System.out.println("\n--- socket events the app parses ---");

        t("room:seat_update      -> SocketSeatUpdateDto -> seats+audience", () ->
                MappersKt.toDomain(G.fromJson(last(sock, "room:seat_update"), SocketSeatUpdateDto.class)));

        t("room:chat_message     -> SocketChatDto -> message", () ->
                MappersKt.toDomain(G.fromJson(last(sock, "room:chat_message"), SocketChatDto.class)));

        t("room:gift_animated    -> SocketGiftAnimatedDto -> gift+sender+receiver", () ->
                MappersKt.toDomain(G.fromJson(last(sock, "room:gift_animated"), SocketGiftAnimatedDto.class)));

        t("room:user_joined      -> SocketUserJoinedDto -> UserJoinedEvent", () -> {
            // fetchMiniUser is the one member query that selects xp, so a joiner always
            // arrives with a resolved rung — the entry banner has nothing to invent.
            for (JsonElement e : sock.getAsJsonArray("room:user_joined")) {
                UserJoinedEvent ev = MappersKt.toDomain(G.fromJson(e, SocketUserJoinedDto.class));
                if (ev.getUser().getRank() == null) {
                    throw new IllegalStateException("joiner carried no rank; the ladder did not ship");
                }
                checkRung(ev.getUser().getRank(), "room:user_joined");
                // A member who bought nothing arrives with neither layer and the banner draws a
                // plain avatar — which is why both are nullable. What must never happen is a
                // half-paid entrance: a ring without art, or a flourish that is not a URL.
                if (ev.getUser().getProfileFrame() != null) {
                    checkFrame(ev.getUser().getProfileFrame(), "room:user_joined");
                }
                if (ev.getUser().getEntryEffect() != null) {
                    String flourish = ev.getUser().getEntryEffect();
                    if (!flourish.startsWith("/") && !flourish.startsWith("https://")) {
                        throw new IllegalStateException("flourish is not an asset URL: " + flourish);
                    }
                }
                // The ride on the join event is what every other device in the room plays, so a
                // half-formed one (a file with no renderer named, or a negative hold) is checked
                // here rather than at the overlay. A joiner who bought nothing stays null.
                if (ev.getUser().getEntryRide() != null) {
                    checkRide(ev.getUser().getEntryRide(), "room:user_joined");
                }
            }
            // The capture equips a ring and a flourish on one account before its socket joins, so
            // the paid layers have to reach the room on the event itself — the room never queries a
            // second endpoint to find out what a new member bought. Which of the two joiners is
            // that account is the capture's business, so the check is over the page, not the last row.
            boolean seesRing = false;
            boolean seesFlourish = false;
            for (JsonElement e : sock.getAsJsonArray("room:user_joined")) {
                JsonObject user = e.getAsJsonObject().getAsJsonObject("user");
                if (user != null && user.get("profileFrame") != null) seesRing = true;
                if (user != null && user.get("entryEffect") != null && !user.get("entryEffect").isJsonNull()) {
                    seesFlourish = true;
                }
            }
            if (!seesRing) throw new IllegalStateException("no join in the capture carried a ring");
            if (!seesFlourish) throw new IllegalStateException("no join in the capture carried a flourish");
        });

        t("MiniUserDto WITHOUT rank leaves the level absent, never zero", () -> {
            // Seats and the audience roster select neither xp nor rank, and Gson runs no
            // default initialiser, so the key is missing rather than empty. A banner that
            // read that as "Newcomer" would contradict the administrator's ladder.
            MiniUser lean = MappersKt.toDomain(
                    G.fromJson("{\"id\":\"u1\",\"username\":\"ana\"}", MiniUserDto.class));
            if (lean.getRank() != null) throw new IllegalStateException("absent rank became " + lean.getRank());
        });

        t("a joiner's entryRide maps through url/format, never the shop row's art/animationFormat", () -> {
            // The two shapes carry the same purchase under different key names, and this is the
            // assertion that keeps them apart: read from the shop spelling, every joiner would
            // arrive with a null URL and the room would play nothing for a ride that was paid for.
            MiniUser rider = MappersKt.toDomain(
                    G.fromJson("{\"id\":\"u1\",\"username\":\"ana\",\"entryRide\":{"
                            + "\"key\":\"ride-confetti\",\"name\":\"Confetti Arrival\","
                            + "\"url\":\"/effects/room-confetti.json\",\"format\":\"SVGA\",\"durationMs\":4000}}",
                            MiniUserDto.class));
            if (rider.getEntryRide() == null) throw new IllegalStateException("the joiner's ride was dropped");
            checkRide(rider.getEntryRide(), "room:user_joined");
            if (rider.getEntryRide().getFormat() != GiftAnimationFormat.SVGA) {
                throw new IllegalStateException("the joiner's renderer was rewritten: " + rider.getEntryRide().getFormat());
            }
            if (rider.getEntryRide().getDurationMs() != 4000) {
                throw new IllegalStateException("the joiner's hold was lost: " + rider.getEntryRide().getDurationMs());
            }
            // A lean roster that never read the ride column stays null — absent means "not shipped",
            // and the room must not announce a ride it was not told about.
            MiniUser noRide = MappersKt.toDomain(G.fromJson("{\"id\":\"u2\",\"username\":\"bo\"}", MiniUserDto.class));
            if (noRide.getEntryRide() != null) throw new IllegalStateException("lean roster carried " + noRide.getEntryRide());
        });

        t("a rung with no name is dropped, art alone is not a level", () -> {
            RankDto dto = G.fromJson("{\"level\":3,\"badge\":\"/badges/level-3.png\"}", RankDto.class);
            UserRank rung = MappersKt.toDomain(dto);
            if (rung != null) throw new IllegalStateException("an unnamed rung reached the banner: " + rung);
        });

        t("a seat/audience roster maps whatever rung it is sent", () -> {
            // Seats and the roster are the lean member queries: today they ship no xp, so the
            // client must read "absent", and if the server ever starts sending a rung here the
            // same code has to paint it without another release.
            JsonArray arr = sock.getAsJsonArray("room:seat_update");
            if (arr == null || arr.size() == 0) throw new IllegalStateException("fixture has no 'room:seat_update' event");
            for (JsonElement e : arr) {
                SocketSeatUpdateDto dto = G.fromJson(e, SocketSeatUpdateDto.class);
                for (SeatDto seat : dto.getSeats()) {
                    if (seat.getUser() == null) continue;
                    UserRank rung = MappersKt.toDomain(seat.getUser()).getRank();
                    if (rung != null) checkRung(rung, "room:seat_update seat " + seat.getSeatIndex());
                }
                for (MiniUserDto member : dto.getAudience()) {
                    UserRank rung = MappersKt.toDomain(member).getRank();
                    if (rung != null) checkRung(rung, "room:seat_update audience");
                }
            }
        });

        t("room:listener_count   -> SocketListenerCountDto", () ->
                G.fromJson(last(sock, "room:listener_count"), SocketListenerCountDto.class));

        t("room:theme_changed    -> SocketThemeChangedDto -> ThemeChangedEvent", () -> {
            SocketThemeChangedDto dto = G.fromJson(last(sock, "room:theme_changed"), SocketThemeChangedDto.class);
            ThemeChangedEvent ev = new ThemeChangedEvent(dto.getRoomId(), dto.getTheme(), dto.getWallpaper());
            if (ev.getTheme() == null || ev.getTheme().isEmpty()) {
                throw new IllegalStateException("broadcast carried an empty theme slug");
            }
            // The client renders the wallpaper, not the slug, so a broadcast without a URL
            // would leave everyone looking at the previous theme's art.
            if (ev.getWallpaper() == null || ev.getWallpaper().isEmpty()) {
                throw new IllegalStateException("broadcast carried no wallpaper URL");
            }
        });

        t("room:profile_updated  -> SocketRoomProfileDto -> RoomProfileEvent", () -> {
            RoomProfileEvent ev = MappersKt.toDomain(
                    G.fromJson(last(sock, "room:profile_updated"), SocketRoomProfileDto.class));
            if (ev.getTitle().isEmpty()) throw new IllegalStateException("edit broadcast lost its title");
            if (ev.getCategory() == null) throw new IllegalStateException("edit broadcast lost its category");
            if (ev.getRules() == null || !ev.getRules().contains("mic off")) {
                throw new IllegalStateException("members were told rules were " + ev.getRules());
            }
        });

        t("room:liked            -> SocketLikeDto -> RoomLikeEvent", () -> {
            // A counted batch, not one event per tap: assert the capture really is
            // aggregated, because a client that summed per-tap events would drift.
            JsonArray arr = sock.getAsJsonArray("room:liked");
            if (arr == null || arr.size() == 0) throw new IllegalStateException("capture has no room:liked event");
            for (JsonElement e : arr) {
                RoomLikeEvent like = MappersKt.toDomain(G.fromJson(e, SocketLikeDto.class));
                if (like.getCount() < 1) throw new IllegalStateException("batch carried a zero count");
                if (like.getTotal() < like.getCount()) {
                    throw new IllegalStateException("running total behind this batch");
                }
            }
        });

        System.out.println("\n--- targeted regressions (Gson + Kotlin defaults) ---");

        t("room object WITHOUT a seats key maps (the crash under test)", () -> {
            RoomDto dto = G.fromJson("{\"id\":\"x\",\"roomNumber\":1,\"title\":\"t\",\"category\":\"PARTY\","
                    + "\"type\":\"PUBLIC\",\"host\":{\"id\":\"h\",\"username\":\"u\"}}", RoomDto.class);
            if (dto.getSeats() != null) throw new IllegalStateException("expected absent seats to deserialise as null");
            MappersKt.toDomain(dto);
        });

        t("room object WITH nested seats maps (create response path)", () -> {
            RoomDto dto = G.fromJson("{\"id\":\"x\",\"roomNumber\":1,\"title\":\"t\",\"category\":\"PARTY\","
                    + "\"type\":\"PUBLIC\",\"host\":{\"id\":\"h\",\"username\":\"u\"},"
                    + "\"seats\":[{\"seatIndex\":0,\"status\":\"OCCUPIED\",\"isMuted\":false,\"isSpeaker\":true,"
                    + "\"user\":{\"id\":\"h\",\"username\":\"u\"}}]}", RoomDto.class);
            if (MappersKt.toDomain(dto).getSeats().size() != 1) throw new IllegalStateException("nested seats lost");
        });

        t("room WITHOUT a theme key falls back to the default look", () -> {
            RoomDto dto = G.fromJson("{\"id\":\"x\",\"roomNumber\":1,\"title\":\"t\",\"category\":\"PARTY\","
                    + "\"type\":\"PUBLIC\",\"host\":{\"id\":\"h\",\"username\":\"u\"}}", RoomDto.class);
            if (dto.getTheme() != null) throw new IllegalStateException("expected absent theme to deserialise as null");
            if (!"aurora".equals(MappersKt.toDomain(dto).getTheme())) {
                throw new IllegalStateException("mapper did not default the theme slug");
            }
        });

        t("live room payloads carry a theme slug AND its wallpaper", () -> {
            JsonObject detail = body(rest, "detail").getAsJsonObject("room");
            JsonElement theme = detail.get("theme");
            if (theme == null || theme.isJsonNull() || theme.getAsString().isEmpty()) {
                throw new IllegalStateException("GET /api/rooms/:id returned no theme — wallpaper lookup would 404");
            }
            if (!detail.has("themeWallpaper") || detail.get("themeWallpaper").isJsonNull()) {
                throw new IllegalStateException("GET /api/rooms/:id returned no themeWallpaper URL");
            }
            Room room = MappersKt.toDomain(G.fromJson(detail, RoomDto.class));
            if (room.getThemeWallpaper() == null || room.getThemeWallpaper().isEmpty()) {
                throw new IllegalStateException("mapper dropped the theme wallpaper");
            }
        });

        t("GET /api/rooms/themes -> ThemeCatalogueDto -> ThemeCatalogue", () -> {
            ThemeCatalogue cat = MappersKt.toDomain(G.fromJson(body(rest, "themes"), ThemeCatalogueDto.class));
            if (cat.getThemes().isEmpty()) throw new IllegalStateException("published catalogue has no theme");
            if (cat.getDefaultTheme().isEmpty()) throw new IllegalStateException("catalogue published no default slug");
            for (RoomThemeOption theme : cat.getThemes()) {
                // The whole point of the catalogue: it hands the client a loadable URL, never a
                // slug it has to turn into a path (operator art lives in the upload store).
                if (!theme.getWallpaper().startsWith("/") && !theme.getWallpaper().startsWith("https://")) {
                    throw new IllegalStateException(theme.getSlug() + " wallpaper is not a URL: " + theme.getWallpaper());
                }
                if (theme.getAccent().isEmpty() || theme.getName().isEmpty()) {
                    throw new IllegalStateException(theme.getSlug() + " lost its name or accent");
                }
            }
            if (cat.getWelcome() != null && !cat.getWelcome().startsWith("/")) {
                throw new IllegalStateException("welcome animation is not a same-origin asset path: " + cat.getWelcome());
            }
        });

        t("catalogue WITHOUT optional keys still maps", () -> {
            ThemeCatalogueDto dto = G.fromJson("{\"themes\":[{\"slug\":\"a\",\"name\":\"A\","
                    + "\"accent\":\"#ffffff\",\"wallpaper\":\"/u/a.png\"}]}", ThemeCatalogueDto.class);
            ThemeCatalogue cat = MappersKt.toDomain(dto);
            if (!"aurora".equals(cat.getDefaultTheme())) {
                throw new IllegalStateException("an old backend left the default slug blank");
            }
            if (cat.getWelcome() != null) throw new IllegalStateException("absent welcome mapped to something");
            if (cat.getThemes().size() != 1) throw new IllegalStateException("catalogue row lost");
        });

        t("GET /api/emoji -> EmojiCatalogueDto -> EmojiCatalogue", () -> {
            EmojiCatalogue cat = MappersKt.toDomain(G.fromJson(body(rest, "emojis"), EmojiCatalogueDto.class));
            if (cat.getEmojis().isEmpty()) throw new IllegalStateException("published catalogue has no emoji");
            // The picker inserts this token and the scanner finds it again, so a code that does
            // not match the published pattern would be typed but never drawn.
            java.util.regex.Pattern scanner = java.util.regex.Pattern.compile(cat.getCodePattern());
            for (EmojiOption option : cat.getEmojis()) {
                if (!scanner.matcher(option.getCode()).matches()) {
                    throw new IllegalStateException(option.getKey() + " code is not scanned: " + option.getCode());
                }
                if (!option.getUrl().startsWith("/") && !option.getUrl().startsWith("https://")) {
                    throw new IllegalStateException(option.getKey() + " art is not a URL: " + option.getUrl());
                }
                if (option.getLabel().isEmpty()) {
                    throw new IllegalStateException(option.getKey() + " lost its label (a11y description)");
                }
            }
        });

        t("emoji catalogue WITHOUT optional keys still maps", () -> {
            EmojiCatalogueDto dto = G.fromJson("{\"emojis\":["
                    + "{\"key\":\"smile\",\"url\":\"/emoji/smile.webp\"},"   // no label, no code
                    + "{\"key\":\"noart\",\"label\":\"No art\",\"code\":\"[noart]\"}" + // no url
                    "]}", EmojiCatalogueDto.class);
            EmojiCatalogue cat = MappersKt.toDomain(dto);
            if (cat.getEmojis().size() != 1) throw new IllegalStateException("row with no art was kept");
            EmojiOption only = cat.getEmojis().get(0);
            if (!"[smile]".equals(only.getCode())) throw new IllegalStateException("derived code is wrong: " + only.getCode());
            if (!"smile".equals(only.getLabel())) throw new IllegalStateException("absent label did not fall back to the key");
            if (!ModelsKt.FALLBACK_EMOJI_CODE_PATTERN.equals(cat.getCodePattern())) {
                throw new IllegalStateException("absent codePattern did not fall back: " + cat.getCodePattern());
            }
        });

        t("an emoji catalogue with nothing usable maps to an empty picker", () -> {
            EmojiCatalogue cat = MappersKt.toDomain(G.fromJson("{}", EmojiCatalogueDto.class));
            if (!cat.getEmojis().isEmpty()) throw new IllegalStateException("absent list became rows");
            // A pattern the server cannot compile would crash every bubble; check the guard holds.
            EmojiCatalogue broken = MappersKt.toDomain(
                    G.fromJson("{\"codePattern\":\"[\",\"emojis\":[]}", EmojiCatalogueDto.class));
            if (!ModelsKt.FALLBACK_EMOJI_CODE_PATTERN.equals(broken.getCodePattern())) {
                throw new IllegalStateException("an un-compilable pattern reached the scanner");
            }
        });

        t("GET /api/rooms/capacity -> SeatPolicyResponse -> SeatPolicy (the form reads its range here)", () -> {
            SeatPolicyResponse dto = G.fromJson(body(rest, "capacity"), SeatPolicyResponse.class);
            SeatPolicy policy = MappersKt.toDomain(dto.getSeatCapacity());
            if (!policy.isUsable()) throw new IllegalStateException("mapper produced an unusable range: " + policy);
            if (policy.getMinSeats() > policy.getDefaultSeats() || policy.getDefaultSeats() > policy.getMaxSeats()) {
                throw new IllegalStateException("published bounds disagree with the published default");
            }
            // Seat 0 is the host, so the speaker count the API names is one seat short of the room.
            if (policy.getDefaultSeats() != dto.getSpeakerSeats() + 1) {
                throw new IllegalStateException("default seats is not speaker seats plus the host seat");
            }
        });

        t("a room created with no capacity gets exactly the capacity the server published", () -> {
            SeatPolicy policy = MappersKt.toDomain(
                    G.fromJson(body(rest, "capacity"), SeatPolicyResponse.class).getSeatCapacity());
            RoomDto dto = G.fromJson(body(rest, "capacityRoom").getAsJsonObject("room"), RoomDto.class);
            if (dto.getSeatCapacity() != policy.getDefaultSeats()) {
                throw new IllegalStateException("server default is " + dto.getSeatCapacity()
                        + " but the policy published " + policy.getDefaultSeats());
            }
            MappersKt.toDomain(dto);
        });

        t("room:warning          -> SocketWarningDto (private channel, so captured inline)", () -> {
            // The capture socket is never the room host, so an admin->host warning can
            // only ever be synthesised here; shape is what this harness checks.
            SocketWarningDto dto = G.fromJson(
                    "{\"roomId\":\"r\",\"message\":\"Please keep the room on-topic\"}", SocketWarningDto.class);
            if (!"r".equals(dto.getRoomId()) || dto.getMessage().isEmpty()) {
                throw new IllegalStateException("warning payload lost a field");
            }
        });

        t("gift event with seatIndex:null (audience receiver)", () -> {
            JsonElement audienceGift = null;
            for (JsonElement e : sock.getAsJsonArray("room:gift_animated")) {
                JsonElement si = e.getAsJsonObject().get("seatIndex");
                if (si != null && si.isJsonNull()) { audienceGift = e; break; }
            }
            if (audienceGift == null) throw new IllegalStateException("capture had no seatIndex:null gift");
            MappersKt.toDomain(G.fromJson(audienceGift, SocketGiftAnimatedDto.class));
        });

        t("room:hand_raise       -> SocketHandRaiseDto -> HandRaiseEvent", () -> {
            JsonArray arr = sock.getAsJsonArray("room:hand_raise");
            if (arr == null || arr.size() == 0) throw new IllegalStateException("capture has no room:hand_raise event");
            for (JsonElement e : arr) {
                if (MappersKt.toDomainOrNull(G.fromJson(e, SocketHandRaiseDto.class)) == null) {
                    throw new IllegalStateException("event with a user object mapped to null");
                }
            }
        });

        t("chat message with user:null (SYSTEM line)", () -> {
            for (JsonElement e : sock.getAsJsonArray("room:chat_message")) {
                if (e.getAsJsonObject().get("user").isJsonNull()) {
                    MappersKt.toDomain(G.fromJson(e, SocketChatDto.class));
                    return;
                }
            }
            throw new IllegalStateException("capture had no SYSTEM (user:null) chat row");
        });

        t("hand_raise WITHOUT user maps to null instead of crashing", () -> {
            SocketHandRaiseDto dto = G.fromJson("{\"roomId\":\"r\",\"raised\":true}", SocketHandRaiseDto.class);
            if (MappersKt.toDomainOrNull(dto) != null) throw new IllegalStateException("expected null for missing user");
        });

        t("like batch WITHOUT user still maps (heart layer draws from it)", () -> {
            SocketLikeDto dto = G.fromJson("{\"roomId\":\"r\",\"count\":12,\"total\":340}", SocketLikeDto.class);
            if (dto.getUser() != null) throw new IllegalStateException("expected absent user to deserialise as null");
            if (MappersKt.toDomain(dto).getTotal() != 340L) throw new IllegalStateException("running total lost");
        });

        t("gift WITHOUT effectKind stays a ticker gift", () -> {
            GiftDto dto = G.fromJson("{\"id\":\"g\",\"name\":\"Rose\",\"iconUrl\":\"/i.png\","
                    + "\"diamondPrice\":99,\"rCoinValue\":50,\"category\":\"SPECIAL\"}", GiftDto.class);
            if (dto.getEffectKind() != null) throw new IllegalStateException("expected absent effectKind to be null");
            if (MappersKt.toDomain(dto).getEffectKind() != GiftEffectKind.TICKER) {
                throw new IllegalStateException("an old backend would have made every rose fullscreen");
            }
        });

        t("live gift payloads carry effectKind", () -> {
            for (JsonElement e : sock.getAsJsonArray("room:gift_animated")) {
                JsonElement kind = e.getAsJsonObject().getAsJsonObject("gift").get("effectKind");
                if (kind == null || kind.isJsonNull()) {
                    throw new IllegalStateException("GET /api/gifts served a gift with no effect tier");
                }
                if (MappersKt.toDomain(G.fromJson(e, SocketGiftAnimatedDto.class)).getGift().getEffectKind()
                        == null) {
                    throw new IllegalStateException("effectKind did not survive the mapper");
                }
            }
        });

        t("gift WITHOUT playback fields plays as the Lottie that has always shipped", () -> {
            GiftDto dto = G.fromJson("{\"id\":\"g\",\"name\":\"Rose\",\"iconUrl\":\"/i.png\","
                    + "\"diamondPrice\":99,\"rCoinValue\":50,\"category\":\"SPECIAL\"}", GiftDto.class);
            if (dto.getAnimationFormat() != null || dto.getDurationMs() != null) {
                throw new IllegalStateException("expected absent playback keys to stay null under Gson");
            }
            com.voiza.app.domain.model.Gift gift = MappersKt.toDomain(dto);
            if (gift.getAnimationFormat() != com.voiza.app.domain.model.GiftAnimationFormat.LOTTIE) {
                throw new IllegalStateException("a row from before migration 0023 must read as the only player that existed");
            }
            if (gift.getDurationMs() != 0 || gift.getDisplayPriority() != 0 || gift.getComboEnabled()) {
                throw new IllegalStateException("playback fields must fall back to the renderer's own clock, no priority, no combo");
            }
            if (gift.getComboWindowMs() != 5000) throw new IllegalStateException("combo window should default, not read as zero");
        });

        t("live gift payloads carry the ids the queue dedupes on", () -> {
            for (JsonElement e : sock.getAsJsonArray("room:gift_animated")) {
                JsonObject obj = e.getAsJsonObject();
                if (obj.get("eventId") == null || obj.get("eventId").isJsonNull()) {
                    throw new IllegalStateException("a paid gift reached the client with no way to recognise it twice");
                }
                com.voiza.app.domain.model.GiftAnimatedEvent ev =
                        MappersKt.toDomain(G.fromJson(e, SocketGiftAnimatedDto.class));
                if (ev.getEventId() == null || ev.getComboId() == null) {
                    throw new IllegalStateException("eventId/comboId did not survive the mapper");
                }
                if (ev.getComboCount() < 1) throw new IllegalStateException("the server's tally must never read as zero");
                if (ev.getGift().getAnimationFormat() == null) {
                    throw new IllegalStateException("animationFormat did not survive the mapper");
                }
            }
        });

        t("box: a live send repeats the roll the ledger paid", () -> {
            int boxes = 0;
            for (JsonElement e : sock.getAsJsonArray("room:gift_animated")) {
                JsonObject obj = e.getAsJsonObject();
                com.voiza.app.domain.model.GiftAnimatedEvent ev =
                        MappersKt.toDomain(G.fromJson(e, SocketGiftAnimatedDto.class));
                com.voiza.app.domain.model.LuckyRoll roll = ev.getLucky();
                if (roll == null) {
                    // A flat gift's event either omits the key or writes it null; both mean "nothing
                    // was drawn", and the overlay must not invent a prize for it.
                    if (obj.has("lucky") && !obj.get("lucky").isJsonNull()) {
                        throw new IllegalStateException("a lucky payload mapped to no roll");
                    }
                    if (ev.getGift().isLuckyBox()) {
                        throw new IllegalStateException("a box send reached the room with no prize to show");
                    }
                    continue;
                }
                boxes += 1;
                if (!ev.getGift().isLuckyBox()) {
                    throw new IllegalStateException("a roll arrived on a gift the catalogue does not call a box");
                }
                // The three money fields are the ledger's own, and the credit the room banks is the
                // event's totalRCoins — a client that re-derived any of them would be arguing with a
                // receipt, and the operator can edit the prize table after the send.
                if (roll.getReceiverRCoins() != ev.getTotalRCoins()) {
                    throw new IllegalStateException("the roll paid " + roll.getReceiverRCoins()
                            + " but the event credited " + ev.getTotalRCoins());
                }
                if (roll.getGrossRCoins() != roll.getReceiverRCoins() + roll.getPlatformTaxRCoins()) {
                    throw new IllegalStateException("the tax is not the remainder of the pool the roll won");
                }
                if (roll.getPrizes().isEmpty() || roll.getHeadline() == null) {
                    throw new IllegalStateException("a rolled box named no prize");
                }
                if (roll.getPrizes().get(0).getMultiplierBps() < roll.getHeadline().getMultiplierBps()) {
                    throw new IllegalStateException("the prize list is not ordered best first");
                }
                long counted = 0;
                for (com.voiza.app.domain.model.LuckyPrize prize : roll.getPrizes()) counted += prize.getCount();
                if (counted != ev.getQuantity()) {
                    throw new IllegalStateException("the draw tallied " + counted + " prizes for "
                            + ev.getQuantity() + " boxes");
                }
            }
            if (boxes == 0) {
                throw new IllegalStateException("this capture sent no lucky box, so the roll shape is unproven");
            }
        });

        t("box: the catalogue's box rows publish odds a phone can print", () -> {
            GiftsResponse gr = G.fromJson(body(rest, "gifts"), GiftsResponse.class);
            int boxes = 0;
            for (GiftDto dto : gr.getGifts()) {
                com.voiza.app.domain.model.Gift gift = MappersKt.toDomain(dto);
                if (!gift.isLuckyBox()) {
                    if (gift.getReceiverShareBps() != null) {
                        throw new IllegalStateException("a flat gift carried a share dial nothing pays: " + gift.getName());
                    }
                    if (!gift.getBoxOutcomes().isEmpty()) {
                        throw new IllegalStateException("a flat gift carried an odds table: " + gift.getName());
                    }
                    continue;
                }
                boxes += 1;
                if (gift.getReceiverShareBps() == null) {
                    throw new IllegalStateException("a box reached the phone with no receiver share: " + gift.getName());
                }
                if (gift.getBoxOutcomes().isEmpty()) {
                    // Not a crash and not a refusal — a loader that did not attach the table. The tile
                    // then states the box without odds, so the flag has to survive on its own.
                    continue;
                }
                int odds = 0;
                for (com.voiza.app.domain.model.GiftBoxOutcome outcome : gift.getBoxOutcomes()) {
                    if (outcome.getLabel().isEmpty()) throw new IllegalStateException("a prize had no name to show");
                    if (outcome.getMultiplierBps() <= 0) throw new IllegalStateException("a prize multiplies by nothing");
                    if (outcome.getChanceBps() < 0) throw new IllegalStateException("a prize published negative odds");
                    odds += outcome.getChanceBps();
                }
                // chanceBps is floored per row, so the table can read a little under whole; it may not
                // read for far less, which is what a mis-scaled odds list would look like.
                if (odds < 9_000) {
                    throw new IllegalStateException(gift.getName() + "'s prizes add up to " + odds + " bps of the box");
                }
            }
            if (boxes == 0) throw new IllegalStateException("this catalogue shipped no lucky box");
        });

        t("a gift_history row and the live event for it are the same gift", () -> {
            // The catch-up tail is emitted from the ledger, the live event from the send. Same paid
            // gift, so the device's dedupe key and the renderer's inputs have to agree field by field.
            JsonObject live = sock.getAsJsonArray("room:gift_animated").get(0).getAsJsonObject();
            JsonObject tail = new JsonObject();
            tail.addProperty("roomId", live.get("roomId").getAsString());
            JsonArray gifts = new JsonArray();
            JsonObject row = new JsonObject();
            row.add("eventId", live.get("eventId"));
            row.add("gift", live.get("gift"));
            row.add("sender", live.get("sender"));
            row.add("receiver", live.get("receiver"));
            row.add("seatIndex", live.get("seatIndex"));
            row.add("quantity", live.get("quantity"));
            row.add("totalDiamonds", live.get("totalDiamonds"));
            row.add("totalRCoins", live.get("totalRCoins"));
            row.add("createdAt", live.get("createdAt"));
            gifts.add(row);
            tail.add("gifts", gifts);

            SocketGiftAnimatedDto liveDto = G.fromJson(live, SocketGiftAnimatedDto.class);
            com.voiza.app.domain.model.GiftAnimatedEvent caught =
                    MappersKt.toDomain(G.fromJson(tail, SocketGiftHistoryDto.class)).get(0);
            com.voiza.app.domain.model.GiftAnimatedEvent seen = MappersKt.toDomain(liveDto);
            if (!caught.getEventId().equals(seen.getEventId())) {
                throw new IllegalStateException("the tail row would animate a gift the room already watched");
            }
            if (caught.getQuantity() != seen.getQuantity()
                    || caught.getTotalDiamonds() != seen.getTotalDiamonds()
                    || caught.getTotalRCoins() != seen.getTotalRCoins()
                    || !caught.getGift().getId().equals(seen.getGift().getId())) {
                throw new IllegalStateException("a replayed gift is described worse than the live one");
            }
            // A tail is history, so it carries no live combo; and it still says which player opens it.
            if (caught.getComboId() != null || caught.getComboCount() != 1) {
                throw new IllegalStateException("a closed combo window must not read as a running one");
            }
            if (caught.getAnimationUrl() == null && seen.getAnimationUrl() != null) {
                throw new IllegalStateException("the tail row lost the animation the live event had");
            }
        });

        t("room WITHOUT ambientEffect/likeCount falls back", () -> {
            RoomDto dto = G.fromJson("{\"id\":\"x\",\"roomNumber\":1,\"title\":\"t\",\"category\":\"PARTY\","
                    + "\"type\":\"PUBLIC\",\"host\":{\"id\":\"h\",\"username\":\"u\"}}", RoomDto.class);
            Room room = MappersKt.toDomain(dto);
            if (!ModelsKt.DEFAULT_AMBIENT_EFFECT.equals(room.getAmbientEffect())) {
                throw new IllegalStateException("mapper did not default the ambient loop");
            }
            if (room.getLikeCount() != 0L) throw new IllegalStateException("absent like count should read as zero");
        });

        t("live room payload names the ambient loop the server chose", () -> {
            JsonObject roomJson = body(rest, "detail").getAsJsonObject("room");
            if (!roomJson.has("ambientEffect") || !roomJson.has("likeCount")) {
                throw new IllegalStateException("room payload is missing an effect/like key the app renders");
            }
            Room room = MappersKt.toDomain(G.fromJson(roomJson, RoomDto.class));
            if (!room.getAmbientEffect().startsWith("/effects/")) {
                throw new IllegalStateException("ambient effect is not a same-origin asset path: " + room.getAmbientEffect());
            }
        });

        t("rank row WITHOUT earned reads as zero rather than crashing", () -> {
            LeaderboardResponse lb = G.fromJson(
                    "{\"window\":\"week\",\"role\":\"receivers\",\"leaders\":[{\"id\":\"u\",\"username\":\"n\"}]}",
                    LeaderboardResponse.class);
            Leaderboard board = MappersKt.toDomain(lb);
            if (board.getRows().size() != 1 || board.getRows().get(0).getEarned() != 0L) {
                throw new IllegalStateException("absent earned did not default to zero");
            }
        });

        t("board with an unreadable role name falls back to hosts", () -> {
            Leaderboard board = MappersKt.toDomain(G.fromJson(
                    "{\"window\":\"day\",\"role\":\"owners\",\"leaders\":[]}", LeaderboardResponse.class));
            if (board.getBoard() != RankBoard.RECEIVERS) throw new IllegalStateException("unknown role mapped to " + board.getBoard());
        });

        System.out.println("--- Games: payloads captured from the live engine ---");

        t("GET /api/games?roomId -> catalog -> definitions + open sessions", () -> {
            GameCatalogResponse cat = G.fromJson(gamesDoc.getAsJsonObject("catalog"), GameCatalogResponse.class);
            if (cat.getGames() == null || cat.getSessions() == null) {
                throw new IllegalStateException("both halves of the desk response are expected keys");
            }
            // Captured against the shipped posture, where every game is switched off: an empty
            // desk must read as empty, not as a screen full of phantom tables.
            for (GameDefinitionDto d : cat.getGames()) GameMappersKt.toDomain(d);
            for (GameSessionDto s : cat.getSessions()) GameMappersKt.toDomain(s);
        });

        t("TIC_TAC_TOE session -> TicTacToeBoard with nine cells", () -> {
            GameSession s = GameMappersKt.toDomain(capturedSession(gamesDoc, "TIC_TAC_TOE"));
            if (!(s.getBoard() instanceof TicTacToeBoard)) {
                throw new IllegalStateException("board came back as " + s.getBoard().getClass().getSimpleName());
            }
            TicTacToeBoard b = (TicTacToeBoard) s.getBoard();
            if (b.getGrid().size() != 9) throw new IllegalStateException("grid is not 9 cells: " + b.getGrid());
            if (b.getWinLine().size() != 0) throw new IllegalStateException("a null winLine must read as none");
            if (s.getTurnDeadlineAtMs() == null) throw new IllegalStateException("turnDeadlineAt did not parse");
        });

        t("QUIZ_BATTLE session -> QuizBoard, and no answer key ever reaches the client", () -> {
            GameSession s = GameMappersKt.toDomain(capturedSession(gamesDoc, "QUIZ_BATTLE"));
            if (!(s.getBoard() instanceof QuizBoard)) {
                throw new IllegalStateException("board came back as " + s.getBoard().getClass().getSimpleName());
            }
            QuizBoard b = (QuizBoard) s.getBoard();
            if (b.getQuestions().isEmpty()) throw new IllegalStateException("no questions parsed");
            JsonArray raw = gamesDoc.getAsJsonObject("games").getAsJsonObject("QUIZ_BATTLE")
                    .getAsJsonObject("read").getAsJsonObject("session").getAsJsonObject("state")
                    .getAsJsonArray("questions");
            for (JsonElement q : raw) {
                JsonObject question = q.getAsJsonObject();
                // The engine strips the key before the DTO leaves the backend; if it ever ships
                // one, this check fails rather than the app quietly learning to read answers.
                if (question.has("answerIndex") || question.has("answer") || question.has("correctIndex")) {
                    throw new IllegalStateException("a quiz question carried an answer key");
                }
            }
            if (b.getLiveQuestion() == null) throw new IllegalStateException("index pointed past the paper");
        });

        t("LUDO session -> seats, yard tokens and a die the engine rolled", () -> {
            GameSession s = GameMappersKt.toDomain(capturedSession(gamesDoc, "LUDO"));
            if (!(s.getBoard() instanceof LudoBoard)) {
                throw new IllegalStateException("board came back as " + s.getBoard().getClass().getSimpleName());
            }
            LudoBoard b = (LudoBoard) s.getBoard();
            LudoSeat turn = b.seat(b.getTurnPosition());
            if (turn == null) throw new IllegalStateException("the turn seat is missing from the board");
            if (turn.getPendingRoll() == null) throw new IllegalStateException("expected the captured pending roll");
            // A seat whose tokens are all in the yard may only spend the engine's own start roll.
            boolean allYard = turn.getPieces().stream().allMatch(v -> v == -1);
            if (allYard) {
                boolean opensLane = turn.getPendingRoll() == b.getStartRoll();
                int movable = turn.legalPieces(turn.getPendingRoll(), b.getStartRoll(), GamesKt.LUDO_HOME).size();
                int expected = opensLane ? turn.getPieces().size() : 0;
                if (movable != expected) {
                    throw new IllegalStateException("client gate offered " + movable + " tokens, the engine allows " + expected);
                }
            }
        });

        t("GET /api/games/me/history -> rows with the server's own fee and prize", () -> {
            GameHistoryResponse h = G.fromJson(gamesDoc.getAsJsonObject("history"), GameHistoryResponse.class);
            if (h.getGames().isEmpty()) throw new IllegalStateException("the capture left no history to read");
            for (GameHistoryRowDto d : h.getGames()) {
                GameHistoryRow row = GameMappersKt.toDomain(d);
                if (row.getNetDiamonds() != row.getPrizeDiamonds() - row.getEntryFeeDiamonds()) {
                    throw new IllegalStateException("net diamonds is not prize minus the server's fee");
                }
            }
        });

        System.out.println("\n--- PK battles (migration 0021) ---");

        // The wire shape `pk:state` and GET /api/pk/rooms/:id send. Captured from a live battle in
        // the e2e phase; repeated here so this harness needs no running stack to check the phone's
        // own reading of it.
        String battleJson = "{\"id\":\"b1\",\"status\":\"ACTIVE\","
                + "\"roomA\":{\"id\":\"ra\",\"title\":\"Nights\",\"coverUrl\":null,\"hostId\":\"ha\",\"hostUsername\":\"alice\"},"
                + "\"roomB\":{\"id\":\"rb\",\"title\":\"Dawn\",\"coverUrl\":\"/c.png\",\"hostId\":\"hb\",\"hostUsername\":\"bob\"},"
                + "\"durationSeconds\":120,\"scores\":{\"a\":300,\"b\":100},\"unit\":\"diamond\","
                + "\"invitedAt\":\"2026-10-30T10:00:00.000Z\",\"inviteExpiresAt\":\"2026-10-30T10:00:10.000Z\","
                + "\"startedAt\":\"2026-10-30T10:00:12.000Z\",\"endsAt\":\"2026-10-30T10:02:12.000Z\","
                + "\"finishedAt\":null,\"remainingMs\":90000,\"winnerRoomId\":null,"
                + "\"bonusXp\":0,\"bonusUserId\":null,\"stopped\":false}";

        t("pk:state payload -> PkBattle copies the ledger scores and resolves the sides", () -> {
            PkBattle battle = PkMappersKt.toDomain(G.fromJson(battleJson, PkBattleDto.class));
            if (battle == null) throw new IllegalStateException("a full battle mapped to null");
            if (!battle.isActive()) throw new IllegalStateException("ACTIVE read as " + battle.getStatus());
            if (battle.getScoreA() != 300 || battle.getScoreB() != 100) {
                throw new IllegalStateException("scores changed on the phone: " + battle.getScoreA() + "/" + battle.getScoreB());
            }
            if (battle.getTotal() != 400) throw new IllegalStateException("total is not the two scores");
            if (Math.abs(battle.getFractionA() - 0.75f) > 0.0001f) {
                throw new IllegalStateException("share bar read " + battle.getFractionA());
            }
            if (battle.sideOf("ra") != PkSide.A || battle.sideOf("rb") != PkSide.B) {
                throw new IllegalStateException("a room did not find its side");
            }
            if (battle.sideOf("elsewhere") != null) throw new IllegalStateException("a foreign room became a side");
            if (!"Dawn".equals(battle.opponentOf("ra").getTitle())) {
                throw new IllegalStateException("opponent lookup returned " + battle.opponentOf("ra").getTitle());
            }
            if (battle.getEndsAtMs() == null) throw new IllegalStateException("endsAt did not parse");
            long endsAt = battle.getEndsAtMs();
            if (battle.remainingAt(endsAt - 30000L) != 30000L) {
                throw new IllegalStateException("clock is not measured against the server's deadline");
            }
            if (!"00:30".equals(battle.clockLabel(30000L)) || !"02:35".equals(battle.clockLabel(155000L))) {
                throw new IllegalStateException("clock label is wrong");
            }
        });

        t("a PK status this build does not know is never drawn as live", () -> {
            PkBattle battle = PkMappersKt.toDomain(
                    G.fromJson(battleJson.replace("\"ACTIVE\"", "\"PAUSED\""), PkBattleDto.class));
            if (battle.getStatus() != PkStatus.UNKNOWN) throw new IllegalStateException("PAUSED read as " + battle.getStatus());
            if (battle.isActive() || battle.isInvited() || battle.isFinished()) {
                throw new IllegalStateException("an unknown status was treated as playable");
            }
            if (battle.remainingAt(System.currentTimeMillis()) != 0) {
                throw new IllegalStateException("an unknown status kept counting");
            }
        });

        t("a PK battle without both rooms maps to null instead of a half board", () -> {
            String noB = battleJson.replace(
                    "\"roomB\":{\"id\":\"rb\",\"title\":\"Dawn\",\"coverUrl\":\"/c.png\",\"hostId\":\"hb\",\"hostUsername\":\"bob\"}",
                    "\"roomB\":null");
            if (PkMappersKt.toDomain(G.fromJson(noB, PkBattleDto.class)) != null) {
                throw new IllegalStateException("a one-room battle reached the screen");
            }
            if (PkMappersKt.toDomain(G.fromJson("{\"status\":\"ACTIVE\"}", PkBattleDto.class)) != null) {
                throw new IllegalStateException("a battle with no id reached the screen");
            }
        });

        t("PK settings publish the durations the invitation may offer", () -> {
            PkSettings settings = PkMappersKt.toDomain(G.fromJson(
                    "{\"isEnabled\":true,\"inviteTimeoutSeconds\":30,\"minDurationSeconds\":10,"
                            + "\"defaultDurationSeconds\":10,\"maxDurationSeconds\":900,\"winnerBonusXp\":40}",
                    PkSettingsDto.class));
            if (!settings.isEnabled()) throw new IllegalStateException("switched-on dials read as off");
            if (settings.getWinnerBonusXp() != 40) throw new IllegalStateException("prize line lost");
            java.util.List<Integer> choices = settings.durationChoices();
            if (!choices.equals(java.util.Arrays.asList(10, 60, 120, 180, 300, 600, 900))) {
                throw new IllegalStateException("choices are " + choices);
            }
            PkSettings narrow = new PkSettings(settings.isEnabled(), 30, 100, 150, 200, 40);
            if (!narrow.durationChoices().equals(java.util.Arrays.asList(120, 150, 180))) {
                throw new IllegalStateException("narrow range offered " + narrow.durationChoices());
            }
        });

        System.out.println("\n" + pass + " passed, " + fail + " failed");
        System.exit(fail == 0 ? 0 : 1);
    }
}
