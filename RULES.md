# Jackaroo rules as implemented

Jackaroo has no single official rulebook; every table has house rules. This app implements the common Gulf/Egyptian set (close to the Jawaker "classic" rules) and exposes the most contested points as options the host can toggle in the lobby.

## Table

- 4, 6 or 8 players. Teams of two; partners sit opposite each other (seat 1 with seat 3 at a 4-player table, seat 1 with seat 4 at a 6-player table, and so on).
- Each player has 4 marbles, a **home** (where marbles wait and return to when killed), a **base** (the star hole at the corner of the player's arm, where marbles come out) and a **safe zone** of 4 cells.
- The track has 19 cells per player (76 for 4 players, 114 for 6, 152 for 8). Marbles move clockwise.
- On the board the holes are numbered 1–18 between consecutive stars. A marble leaves its star onto hole 1, runs round the whole track and comes home through hole 18, the last hole before its own star, where the safe column branches off.
- One standard 52-card deck for 4 players, two decks for 6 and 8. Jokers are optional (2 per deck).

## Dealing

- From a fresh deck, the first deal is **5 cards** each; every later deal is **4 cards** each. With one deck and 4 players this is exactly 5 + 4 + 4 = 13 cards per player, the whole deck.
- When the stock cannot cover the next deal, a new deck is shuffled.
- The dealer rotates one seat each deal; the player after the dealer starts.
- Shuffling uses a cryptographic random generator. Before the first card of a deck is dealt the server publishes `SHA-256(salt:order)`; when the deck is finished the salt and order are revealed and can be checked in the "Fairness check" panel.

## Your turn

You must play a card if **any** card in your hand has a legal move. If no card can be played you **burn** (discard) a card of your choice without moving. Then the turn passes to the next player.

| Card | Effect |
|---|---|
| **A** | Take a marble from home to your base, **or** move a marble 1, **or** 11 steps. |
| **K** | Take a marble from home to your base, **or** (option *King 13 kills*, default on) move 13 steps killing every marble you pass or land on. |
| **Q** | Move 12. A **red** Queen (hearts, diamonds) may instead pick one of the next player's cards face down and burn it (option *complex cards*, default on). |
| **J** | **Black** Jack (spades, clubs) is a **swap card**: swap one of your marbles on the track with any other player's marble on the track (partner included). Marbles standing on their own base, in a safe zone or at home cannot be swapped. **Red** Jack: move 11. (With *complex cards* off, every Jack swaps.) |
| **10** | Move 10, **or** make the next player burn a card of their choice before they take their turn (option *complex cards*). |
| **9, 8, 6, 3, 2** | Move that many steps. |
| **7** | Move 7, or split the 7 between two of your marbles in any way (1+6, 2+5, 3+4 and so on). Each part must be legal on its own, in order. |
| **5** | Move any marble on the track 5 steps: yours, your partner's or an opponent's (option *5 moves any marble*, default on). A marble moved by someone else cannot be pushed into its safe zone, and another player's marble standing on its own base cannot be moved at all. |
| **4** | Move 4 steps **backwards**. |
| **Joker** | Plays as any card above (option, default off). |

## Movement, killing and protection

- Landing on another marble sends it home (**kill**). This applies to partner marbles too. You cannot land on your own marble.
- You may jump over other players' marbles on the track (partner included), but **not over your own marbles** (option *may jump own marbles*, default off). Base protection is absolute: a marble standing on **its own base** cannot be passed, killed, swapped or moved by another player's 5, not even by a King's 13.
- **Wall**: two marbles of the **same team** on two consecutive track cells block everyone (King included, and their own team too) from passing over them, in either direction. You may land on the first of the two (and kill it); you may not land on or pass the second. Two marbles of different teams side by side do not block.
- Taking a marble out kills whatever other player's marble is sitting on your base. You cannot take a marble out while your own marble is on your base.
- Moving backwards with a 4 can pass and kill the same way (a marble on its own base still blocks).

## Safe zone

- The safe zone branches off the hole just **before** your base, so the base is never on the way in. A marble enters its safe zone after going round the track. The card must fit: you cannot overshoot the last safe cell.
- Inside the safe zone marbles cannot jump over each other and cannot move backwards.
- The classic trick works: a marble that moves 4 **backwards** from its base is now "at the end of its lap" and can enter the safe zone with a later card.

## Finishing and winning

- When all four of your marbles are in your safe zone you keep receiving and playing cards, but you move your **partner's** marbles.
- The first team with all **8** marbles in their safe zones wins.
- The host can start a rematch with the same table; the seats stay as they were.

## Things this app decides that tables often argue about

- A King's 13-step move kills every unprotected marble it passes, yours and your partner's included.
- A 5 played on another player's marble can kill, but cannot push that marble into its safe zone.
- A player who was made to burn by a 10 burns first and then plays normally in the same turn. A player whose hand runs out early is skipped until the next deal.
- Jokers played as a Jack may swap (like a swap card) or move 11; played as a Queen they may move 12 or burn.
