# Pokemon Red/Blue local guide corpus

Purpose: local, low-frequency walkthrough lookup for the autonomous LLM player. The model should request a lookup only when local RAM/screenshot/map memory are insufficient (e.g. lost, new dungeon/town, story gate, repeated coordinate loop). Do not query this every turn.

## Trusted walkthrough / reference sources

1. Bulbapedia — Walkthrough: Pokémon Red and Blue
   - URL: https://bulbapedia.bulbagarden.net/wiki/Appendix:Red_and_Blue_walkthrough
   - Why trusted: Bulbapedia is a long-running community encyclopedia with detailed Gen 1 route/event documentation and cross-linked mechanics/location pages.

2. Serebii — Pokémon Red & Blue section
   - URL: https://www.serebii.net/rb/
   - Why trusted: Serebii is a long-running Pokémon reference site. Use it mainly for location, encounter, item, and Pokédex cross-checks rather than turn-by-turn pathing.

3. Serebii Pokéarth — Kanto
   - URL: https://www.serebii.net/pokearth/kanto/
   - Why trusted: map/location reference by Kanto area; useful for route/city/dungeon context.

4. StrategyWiki — Pokémon Red and Blue
   - URL: https://strategywiki.org/wiki/Pok%C3%A9mon_Red_and_Blue
   - Why trusted: structured open strategy guide. If direct access is blocked, use browser/manual lookup or mirrors cautiously.

## Early-game route facts from walkthrough consensus

### Pallet Town / Oak / starter
- From Pallet Town, trying to leave north into Route 1 triggers Professor Oak if the player has no starter.
- Oak leads the player to Oak's Lab and lets the player choose a starter.
- After choosing a starter, Rival chooses the advantageous starter and challenges the player.
- After the Rival battle, leave Oak's Lab and go north to Route 1 / Viridian City.

### Route 1
- Route 1 connects Pallet Town and Viridian City.
- Early objective after starter: go north through Route 1 to Viridian City.
- Wild encounters are low-level; fight if safe, but story progress is more important than grinding.

### Viridian City / Parcel
- The Viridian Poké Mart clerk gives Oak's Parcel when the player first enters/talks during the initial visit.
- After receiving Oak's Parcel, return south through Route 1 to Pallet Town and deliver it to Professor Oak in Oak's Lab.
- Delivering the parcel gives the player the Pokédex and Rival's sister gives the Town Map in the house north of the player home, but Town Map is optional.
- After Pokédex, go back north to Viridian City and continue toward Route 2 / Viridian Forest.

### Viridian Mart map 44 local trap notes
- Viridian Mart is indoor map 44 in this harness.
- The useful story interaction is the clerk/counter, not the nickname NPC.
- If near map 44 y=4 x=5 facing up/right and repeated nickname/non-story text appears, stop pressing A/up, clear text, then walk south/down to the exit.
- Exit is at the bottom/south side; after exiting a building, sidestep before walking north to avoid re-entering.

### Route 2 / Viridian Forest / Brock
- Route 2 north of Viridian City leads toward Viridian Forest before Pewter City.
- Viridian Forest is a maze-like early dungeon with Bug Catchers and wild Bug/Poison Pokémon; keep HP safe and fight with damaging moves.
- Continue generally north/west/east through forest exits according to local map evidence; if stuck, consult route/forest guide and screenshot.
- Pewter City contains the first Gym. Brock uses Rock/Ground Pokémon (Geodude, Onix in Red/Blue). If using Charmander, extra leveling or non-Fire moves are needed; Squirtle/Bulbasaur are favorable.

## Lookup policy
- Prefer live RAM/screenshot and learned map edges over guide text for immediate movement.
- Use guide lookup for story order, destination choice, dungeon/city orientation, and repeated stuck loops.
- Never emit a global precomputed input timeline from guide text; convert guide facts into short, bounded controller actions based on current coordinates/screenshot.
