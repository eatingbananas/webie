(() => {
  let allEntries = [];
  let currentFilter = 'all'; // 'all' | 'non-all'
  let currentSearch = '';

  // ── Fetch and boot ──────────────────────────────────────────────────────────

  fetch('content.json')
    .then(r => {
      if (!r.ok) throw new Error('Could not load content.json');
      return r.json();
    })
    .then(data => {
      allEntries = data;
      render();
      hookControls();
    })
    .catch(err => {
      document.getElementById('main').innerHTML =
        '<p style="color:#c00; font-size:11px; padding:10px;">Error: ' + err.message + '</p>';
    });

  // ── Filtering logic ─────────────────────────────────────────────────────────

  function filtered() {
    return allEntries.filter(entry => {
      const matchesFilter =
        currentFilter === 'all' || entry.type !== 'found';

      const q = currentSearch.trim().toLowerCase();
      const matchesSearch =
        !q ||
        entry.title.toLowerCase().includes(q) ||
        entry.year.toLowerCase().includes(q) ||
        entry.type.toLowerCase().includes(q);

      return matchesFilter && matchesSearch;
    });
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  function render() {
    const main = document.getElementById('main');
    const entries = filtered();

    if (entries.length === 0) {
      main.innerHTML = '<p style="font-size:11px; color:#888; padding:8px 0;">No entries match.</p>';
      return;
    }

    const rows = entries.map(entry => {
      const thumb = entry.src
        ? `<img src="${entry.src}" alt="${entry.title}" style="width:80px; height:auto; display:block; object-fit:cover;">`
        : `<span style="display:inline-block; width:80px; height:54px; background:#f0f0f0;"></span>`;

      const project = entry.project || '—';

      return `<tr>
        <td>${thumb}</td>
        <td>${entry.title}</td>
        <td>${entry.year}</td>
        <td>${entry.type}</td>
        <td>${project}</td>
      </tr>`;
    }).join('');

    main.innerHTML = `
      <table class="db-table">
        <thead>
          <tr>
            <th></th>
            <th>title</th>
            <th>year</th>
            <th>type</th>
            <th>project</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="db-count">${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}</p>
    `;
  }

  // ── Wire up controls ────────────────────────────────────────────────────────

  function hookControls() {
    // Search input + find button
    const input  = document.querySelector('#searchbar input');
    const button = document.querySelector('#searchbar button');

    function doSearch() {
      currentSearch = input.value;
      render();
    }

    button.addEventListener('click', doSearch);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') doSearch();
    });
    // Live filter as you type
    input.addEventListener('input', doSearch);

    // all / non all navbar links
    const navLinks = document.querySelectorAll('#navbar a');
    navLinks.forEach(link => {
      link.addEventListener('click', e => {
        e.preventDefault();
        navLinks.forEach(l => l.classList.remove('active'));
        link.classList.add('active');
        currentFilter = link.textContent.trim() === 'all' ? 'all' : 'non-all';
        render();
      });
    });
  }
})();
