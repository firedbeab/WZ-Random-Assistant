const theme = require('../../utils/theme');

Component(theme.component({
  methods: {
    toggle() {
      const current = theme.getState();
      theme.setPreference({ mode: current.resolved === 'dark' ? 'light' : 'dark', palette: current.palette });
    }
  }
}));
