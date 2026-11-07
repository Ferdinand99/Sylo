// The three stages of a roadmap post: the label people see (on the public Roadmap and in the
// admin list) and the badge tone. One map, so both pages say the same thing.
export const ROADMAP_STATUS = {
  planned: { label: 'Planned', tone: 'neutral' },
  started: { label: 'In progress', tone: 'warning' },
  completed: { label: 'Recently shipped', tone: 'success' },
};
