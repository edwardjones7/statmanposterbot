// Offline sample tweets covering layout edge cases: length, line breaks, emoji, entities.
import type { Tweet } from "../src/tweet/fetch.ts";

const author: Tweet["author"] = {
  name: "Sample Author",
  handle: "sampleauthor",
  avatarUrl: "https://pbs.twimg.com/profile_images/1661201415899951105/azNjKOSH_400x400.jpg",
  verified: "blue",
};

const base = { url: "https://x.com/sampleauthor/status/0", createdAt: new Date("2026-09-27T14:05:00Z"), author };

export const SAMPLES: Tweet[] = [
  {
    ...base,
    id: "sample-stats",
    text: "NFL Week 4 system update 📊\n\nHome underdogs off a loss: 38-22-1 ATS (63.3%) since 2015.\nThis week: +3.5 at -110 ❤️‍🔥\n\nFull breakdown for members at edthestatman.com #NFL",
  },
  {
    ...base,
    id: "sample-medium",
    text: "Distribution is the whole game. 🚀\n\nMost founders spend 90% of their time building and 10% telling people about it. Flip that ratio for one month and watch what happens. h/t @naval",
  },
  {
    ...base,
    id: "sample-long",
    text: "5 lessons from growing to 100k followers:\n\n1. Consistency beats virality 📈\n2. Write for one person, not everyone\n3. Steal formats, not ideas\n4. Reply more than you post 💬\n5. Every post should earn the next follow\n\nFull breakdown on my blog: example.com/growth #buildinpublic",
  },
  {
    ...base,
    id: "sample-max",
    text: "Here's the uncomfortable truth about content in 2026: the algorithm doesn't care how long you spent on it. It cares whether the first line stopped someone scrolling. So spend 80% of your effort on the hook, 15% on the body, and 5% on everything else. Then post it everywhere your audience already is — X, Instagram, LinkedIn, Threads. One idea, five distribution channels, zero extra writing. That's leverage. 🔁✨",
  },
];
