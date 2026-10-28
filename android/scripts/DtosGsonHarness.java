import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.voiza.app.data.mapper.GameMappersKt;
import com.voiza.app.data.mapper.MappersKt;
import com.voiza.app.data.remote.dto.*;
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
import com.voiza.app.domain.model.Leaderboard;
import com.voiza.app.domain.model.ModelsKt;
import com.voiza.app.domain.model.MiniUser;
import com.voiza.app.domain.model.RankBoard;
import com.voiza.app.domain.model.RankRow;
import com.voiza.app.domain.model.UserJoinedEvent;
import com.voiza.app.domain.model.UserRank;
import com.voiza.app.domain.model.Room;
import com.voiza.app.domain.model.RoomProfileEvent;
import com.voiza.app.domain.model.RoomType;
import com.voiza.app.domain.model.SeatPolicy;
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

        System.out.println("\n--- socket events the app parses ---");

        t("room:seat_update      -> SocketSeatUpdateDto -> seats+audience", () ->
                MappersKt.toDomain(G.fromJson(last(sock, "room:seat_update"), SocketSeatUpdateDto.class)));

        t("room:chat_message     -> SocketChatDto -> message", () ->
                MappersKt.toDomain(G.fromJson(last(sock, "room:chat_message"), SocketChatDto.class)));

        t("room:gift_animated    -> SocketGiftAnimatedDto -> gift+sender+receiver", () ->
                MappersKt.toDomain(G.fromJson(last(sock, "room:gift_animated"), SocketGiftAnimatedDto.class)));

        t("room:user_joined      -> SocketUserJoinedDto -> UserJoinedEvent", () -> {
            UserJoinedEvent ev = MappersKt.toDomain(
                    G.fromJson(last(sock, "room:user_joined"), SocketUserJoinedDto.class));
            // fetchMiniUser is the one member query that selects xp, so the joiner always
            // arrives with a resolved rung — the entry banner has nothing to invent.
            if (ev.getUser().getRank() == null) {
                throw new IllegalStateException("joiner carried no rank; the ladder did not ship");
            }
            checkRung(ev.getUser().getRank(), "room:user_joined");
        });

        t("MiniUserDto WITHOUT rank leaves the level absent, never zero", () -> {
            // Seats and the audience roster select neither xp nor rank, and Gson runs no
            // default initialiser, so the key is missing rather than empty. A banner that
            // read that as "Newcomer" would contradict the administrator's ladder.
            MiniUser lean = MappersKt.toDomain(
                    G.fromJson("{\"id\":\"u1\",\"username\":\"ana\"}", MiniUserDto.class));
            if (lean.getRank() != null) throw new IllegalStateException("absent rank became " + lean.getRank());
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

        System.out.println("\n" + pass + " passed, " + fail + " failed");
        System.exit(fail == 0 ? 0 : 1);
    }
}
