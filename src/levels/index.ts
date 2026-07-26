import { buildLevel, type ArtSpec } from '../gen/art';
import type { LevelSpec } from '../core/types';

/**
 * Palettes are chosen for perceptual separation, not just prettiness — the
 * generator asserts a minimum CIEDE2000 gap between any two colours that touch
 * in the picture, and force-enables symbol mode when art demands closer ones.
 */
const ART: readonly ArtSpec[] = [
  {
    id: 'heart',
    name: 'Heart',
    // Shaded deliberately: a picture dominated by one colour cannot be fully
    // deranged (a colour covering over half the cells must sit on itself
    // somewhere), which makes for a limp puzzle. Four balanced colours fix it.
    colours: { r: '#7a1533', R: '#ff6b84', d: '#c43a8f', w: '#fff0f4' },
    rows: [
      '...rrr....rrr...',
      '..rRRRr..rRRRr..',
      '.rRwwRRrrRRRRRr.',
      '.rwwwRRRRRRRRdr.',
      '.rRwwRRRRRRRddr.',
      '.rRRRRRRRRddddr.',
      '..rRRRRRRRdddr..',
      '..rRRRRRRddddr..',
      '...rRRRRRdddr...',
      '....rRRRdddr....',
      '.....rRRddr.....',
      '......rddr......',
      '.......dd.......',
    ],
  },
  {
    id: 'mushroom',
    name: 'Toadstool',
    colours: { r: '#e03a3a', w: '#fff6e8', c: '#cf9b57', k: '#3a2a2a' },
    rows: [
      '.....rrrrrr.....',
      '...rrwwrrwwrr...',
      '..rrwwrrrrwwrr..',
      '.rrrrrrwwrrrrrr.',
      '.rwwrrrrrrrrwwr.',
      '.rrrrrrrrrrrrrr.',
      '..cccccccccccc..',
      '...cckkcckkcc...',
      '...cccccccccc...',
      '....cccccccc....',
      '....cccccccc....',
      '....cccccccc....',
      '.....cccccc.....',
      '......cccc......',
    ],
  },
  {
    id: 'balloon',
    name: 'Balloon',
    // Banded art keeps every colour under ~40% of the picture, so almost every
    // cell can start misplaced. Compare `minimumPreMatched`.
    colours: { R: '#d93a30', c: '#fff6e8', y: '#ffc531', w: '#7c8698', k: '#8a5a2b' },
    rows: [
      '.....RRRRRR.....',
      '...RRRccccRRR...',
      '..RRccccccccRR..',
      '..RcccyyyycccR..',
      '.RcccyyyyyycccR.',
      '.RccyyyyyyyyccR.',
      '.RccyyyyyyyyccR.',
      '..RcccyyyycccR..',
      '..RRccccccccRR..',
      '...RRRccccRRR...',
      '.....RRRRRR.....',
      '......RwwR......',
      '.......ww.......',
      '......kkkk......',
      '......kkkk......',
    ],
  },
  {
    id: 'daisy',
    name: 'Daisy',
    colours: { w: '#fdfdf6', W: '#a89ad6', y: '#ffc531', g: '#4caf50', G: '#1f5c24' },
    rows: [
      '....ww....WW....',
      '...wwww..WWWW...',
      '...wwwwwWWWWW...',
      '....wwwyyWWW....',
      '.....wyyyyW.....',
      '...WWWyyyywww...',
      '..WWWWWyywwwww..',
      '...WWWWWwwwww...',
      '....WWW..www....',
      '.......gg.......',
      '.......gg.......',
      '......ggg.......',
      '.....GGgg.......',
      '.......ggGG.....',
      '.......gg.......',
    ],
  },
  {
    id: 'rocket',
    name: 'Rocket',
    colours: { w: '#e8ecf5', R: '#e8453c', c: '#3fc7f4', o: '#ff8a1e', y: '#ffe14d' },
    rows: [
      '.......ww.......',
      '......wwww......',
      '......wRRw......',
      '.....wRccRw.....',
      '.....wRccRw.....',
      '.....wRRRRw.....',
      '....wwRRRRww....',
      '...wRwRRRRwRw...',
      '...wRwRRRRwRw...',
      '...wRwwwwwwRw...',
      '...wwww..wwww...',
      '......oooo......',
      '.....oyyyyo.....',
      '......oyyo......',
      '.......oo.......',
    ],
  },
];

export const LEVELS: readonly LevelSpec[] = ART.map(buildLevel);

export function levelById(id: string): LevelSpec | undefined {
  return LEVELS.find((l) => l.id === id);
}
