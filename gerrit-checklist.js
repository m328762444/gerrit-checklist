// ==UserScript==
// @name         Gerrit Review Checklist 2.0
// @namespace    https://github.com/MrGrinst/gerrit-checklist
// @version      2.0.0
// @description  Add a checklist to your Gerrit review panel, and record responses with your submitted comments.
// @include      https://gerrit.instructure.com/*
// @copyright    2014+ Michael Ziwisky, 2019+ Kyle Grinstead
// ==/UserScript==

// example .gerrit-checklist.json file
// this file should be in the root directory of the repo
//
// {
//   "checklist": [
//     "FE: works in a mobile browser",
//     "BE: queries are optimized"
//   ],
//  "defaultStatus": false // a default status of false == Not Checked, true == Checked, null == N/A
// }

// HELPER FUNCTIONS

function buildElement(tag, options) {
  const element = document.createElement(tag);
  Object.keys(options || {}).forEach(function(optionKey) {
    if (options[optionKey] !== null) {
      element[optionKey] = options[optionKey];
    }
  });
  return element;
}

function extractTextFromSelectorWithRegex(selector, regex) {
  const elements = document.querySelectorAll(selector);
  for (const element of Array.from(elements)) {
    const match = element.textContent && element.textContent.match(regex);
    if (match) {
      return match[1];
    }
  }
  return null;
}

function querySelectorContaining(selector, text) {
  const elements = document.querySelectorAll(selector);
  for (const element of Array.from(elements)) {
    if (element.textContent.includes(text)) {
      return element;
    }
  }
  return null;
}

// CONSTANTS

const DEFAULT_CHECKLIST = [
  'Changeset checked out and tried',
  'Commit message test plan is sufficient for manual sanity checking',
  'Automated tests cover all necessary cases',
  'User-facing strings/dates/times/numbers are internationalized',
  'UI interactions are accessible to screen reader, keyboard only, and visually impaired users',
];
const DEFAULT_DEFAULT_STATUS = null;

// ReviewChecklistManager.js

function ReviewChecklistManager() {
  console.log('Gerrit review checklist added!');
  this.setChecklistSettings(DEFAULT_CHECKLIST, DEFAULT_DEFAULT_STATUS);
  this.isPolyGerrit = !!document.querySelector('gr-app');
  this.textAreaDomSelector = this.isPolyGerrit
    ? 'gr-reply-dialog gr-textarea textarea'
    : '.popupContent .gwt-TextArea';
}

ReviewChecklistManager.create = function(defaultOptsList) {
  if (ReviewChecklistManager.instanceCreated) {
    console.log('Only a single Gerrit checklist is allowed.');
    return;
  }
  ReviewChecklistManager.instanceCreated = true;

  new ReviewChecklistManager().activate();
};

ReviewChecklistManager.prototype.activate = function() {
  new MutationObserver(this.domChangeListener.bind(this)).observe(
    document.body,
    {childList: true, subtree: true},
  );
};

ReviewChecklistManager.prototype.resetIfLocationChanged = function() {
  if (this.previousLocation !== document.location.toString()) {
    this.previousLocation = document.location.toString();
    this._isSelfAuthored = undefined;
    this.gerritTextArea = undefined;

    const _this = this;
    const repoNameMatch = document.location.toString().match(/\/c\/(.*)\/\+/);
    if (repoNameMatch) {
      fetch(
        `${window.location.protocol}${
          window.location.hostname
        }/plugins/gitiles/${
          repoNameMatch[1]
        }/+/master/.gerrit-checklist.json?format=TEXT`,
      )
        .then(function(res) {
          return res.text().then(function(base64) {
            if (base64 && base64 !== '') {
              const customSettings = JSON.parse(atob(base64));
              const {checklist, defaultStatus} = customSettings;
              _this.setChecklistSettings(checklist, defaultStatus);
            } else {
              _this.setChecklistSettings();
            }
          });
        })
        .catch(function(e) {
          console.error(e);
          _this.setChecklistSettings();
        });
    } else {
      this.setChecklistSettings();
    }
  }
};

ReviewChecklistManager.prototype.setChecklistSettings = function(
  checklist = DEFAULT_CHECKLIST,
  defaultStatus = DEFAULT_DEFAULT_STATUS,
) {
  const _this = this;
  this.options = checklist.map(function(opt) {
    const option = {
      text: opt,
      status: defaultStatus,
      setStatus: function(status) {
        this.status = status;
        _this.updateManagedTextArea();
      },
    };
    return option;
  });
};

ReviewChecklistManager.prototype.domChangeListener = function() {
  try {
    this.resetIfLocationChanged();

    if (!this.textAreaIsVisible()) return; // stop if review popover is not open
    if (!this.qaHasBeenRejectedOrApproved()) return; // stop if QA hasn't been +1/-1
    if (this.isSelfAuthored()) return; // stop if current user is the author

    const gerritTextArea = document.querySelector(this.textAreaDomSelector);
    this.manageTextArea(gerritTextArea);
    if (!this.optionsArePresent()) {
      this.insertOptions();
    }
  } catch (e) {
    console.error(e);
  }
};

ReviewChecklistManager.prototype.manageTextArea = function(gerritTextArea) {
  if (this.gerritTextArea && this.gerritTextArea === gerritTextArea) return;
  if (!this.textArea) {
    this.createStandinTextArea();
  }

  this.gerritTextArea = gerritTextArea;
  this.textArea.value = gerritTextArea.value;
  gerritTextArea.parentElement.insertBefore(
    this.textArea,
    gerritTextArea.nextSibling,
  );
  gerritTextArea.style.position = 'fixed';
  gerritTextArea.style.left = '-10000px'; // like hide(), but allows it to get focus
  const ta = this.textArea;
  gerritTextArea.addEventListener('focus', function() {
    ta.focus();
  });
  this.updateManagedTextArea();
};

ReviewChecklistManager.prototype.createStandinTextArea = function() {
  let textAreaOptions;
  if (this.isPolyGerrit) {
    textAreaOptions = {
      autocomplete: true,
      placeholder: 'Say something nice...',
      rows: 4,
    };
  } else {
    textAreaOptions = {
      rows: 5,
      cols: 70,
    };
  }
  this.textArea = buildElement('textarea', textAreaOptions);
  this.textArea.classList.add('style-scope', 'iron-autogrow-textarea');

  this.textArea.addEventListener(
    'change',
    this.updateManagedTextArea.bind(this),
  );
  this.textArea.addEventListener(
    'input',
    this.updateManagedTextArea.bind(this),
  );

  // forward special key sequences to the original textArea to get special behaviors
  const _this = this;
  this.textArea.addEventListener('keydown', function(evt) {
    if (
      (evt.which == 13 && evt.ctrlKey) || // ctrl-Enter
      evt.which == 27 // esc
    ) {
      _this.gerritTextArea.focus();
      _this.gerritTextArea.trigger(evt);
    }
  });
};

ReviewChecklistManager.prototype.updateManagedTextArea = function() {
  if (!this.gerritTextArea) return;
  this.gerritTextArea.value = '' + this.textArea.value + this.checklistText();
  this.gerritTextArea.dispatchEvent(new Event('input', {bubbles: true}));
};

ReviewChecklistManager.prototype.insertOptions = function() {
  if (this.isPolyGerrit) {
    const section = buildElement('section');
    section.classList.add('style-scope', 'gr-reply-dialog');
    section.appendChild(this.buildOptionsTable());

    const radioButtonsContainer = querySelectorContaining(
      'gr-reply-dialog section.labelsContainer',
      'Code-Review',
    );
    if (radioButtonsContainer && this.options.length > 0) {
      radioButtonsContainer.parentElement.insertBefore(
        section,
        radioButtonsContainer.nextSibling,
      );
    }
  } else {
    const radioButtonsContainer = querySelectorContaining(
      'div.com-google-gerrit-client-change-Resources-Style-section',
      'Code-Review',
    );
    if (radioButtonsContainer && this.options.length > 0) {
      radioButtonsContainer.parentElement.insertBefore(
        this.buildOptionsTable(),
        radioButtonsContainer.nextSibling,
      );
    }
  }
};

ReviewChecklistManager.prototype.checklistText = function() {
  const positive = [];
  const negative = [];
  this.options.forEach(function(option) {
    if (option.status === true) positive.push(option.text);
    else if (option.status === false) negative.push(option.text);
  });

  let message = '';

  if (positive.length > 0) {
    message += '\n\n  Reviewer checked:';
    positive.forEach(function(pos) {
      message += '\n   * ' + pos;
    });
  }
  if (negative.length > 0) {
    message += '\n\n  Reviewer DID NOT check:';
    negative.forEach(function(neg) {
      message += '\n   * ' + neg;
    });
  }

  return message;
};

ReviewChecklistManager.prototype.buildOptionsTable = function() {
  const headers = ['N/A', 'no', 'yes'];
  const statuses = [null, false, true];

  const rows = this.options.map(function(option, index) {
    const tr = buildElement('tr');
    statuses.forEach(function(val) {
      const box = buildElement('input', {
        type: 'radio',
        name: 'checkbox_' + index,
        checked: val === option.status ? 'checked' : null,
      });
      box.addEventListener('change', function() {
        option.setStatus(val);
      });
      const td = buildElement('td');
      td.appendChild(box);
      tr.appendChild(td);
    });
    const td = buildElement('td', {
      align: 'left',
      style: 'vertical-align: middle; padding-left: 5px; font-size: 0.9em',
      textContent: option.text,
    });
    tr.appendChild(td);
    return tr;
  });

  const headerRow = buildElement('tr');
  headers.forEach(function(text) {
    const th = buildElement('th', {align: 'center', textContent: text});
    headerRow.appendChild(th);
  });
  const firstTh = buildElement('th', {textContent: 'Did you verify:'});
  headerRow.appendChild(firstTh);
  const thead = buildElement('thead');
  thead.appendChild(headerRow);

  const tbody = buildElement('tbody', {id: 'review-checklist'});
  rows.forEach(function(row) {
    tbody.appendChild(row);
  });

  const table = buildElement('table', {cellSpacing: 8, cellPadding: 0});
  table.appendChild(thead);
  table.appendChild(tbody);
  return table;
};

ReviewChecklistManager.prototype.textAreaIsVisible = function() {
  if (this.isPolyGerrit) {
    const overlay = document.querySelector('#replyOverlay');
    return overlay && overlay.getAttribute('aria-hidden') !== 'true';
  } else {
    return !!document.querySelector(this.textAreaDomSelector);
  }
};

ReviewChecklistManager.prototype.qaHasBeenRejectedOrApproved = function() {
  if (this.isPolyGerrit) {
    const qaInputs = document.querySelectorAll(
      'gr-label-score-row[name=QA-Review] gr-button',
    );
    const selectedIndex = Array.from(qaInputs)
      .map(function(e) {
        return e.classList.contains('iron-selected');
      })
      .indexOf(true);
    return selectedIndex !== 1; // the middle QA-Review value isn't selected,
    // meaning Rejected or Approved is selected
  } else {
    const qaInputs = document.querySelectorAll('input[name=QA-Review]');
    const selectedIndex = Array.from(qaInputs)
      .map(function(e) {
        return e.checked;
      })
      .indexOf(true);
    return selectedIndex !== 1; // the middle QA-Review value isn't selected,
    // meaning Rejected or Approved is selected
  }
};

ReviewChecklistManager.prototype.isSelfAuthored = function() {
  if (this._isSelfAuthored === undefined) {
    if (this.isPolyGerrit) {
      const authorName = extractTextFromSelectorWithRegex(
        'section',
        /^\s*Owner\s+(.*?)\s+\(/,
      );
      const currentUserName = extractTextFromSelectorWithRegex(
        'ul.gr-dropdown > div',
        /^\s*(.*?)\s+\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+\s*/,
      );
      this._isSelfAuthored =
        authorName && currentUserName && authorName === currentUserName;
    } else {
      const authorName = extractTextFromSelectorWithRegex(
        'tr',
        /^\s*Author\s+(.*?)\s+</,
      );
      this._isSelfAuthored =
        authorName &&
        authorName ===
          document.querySelector('span.menuBarUserName').textContent.trim();
    }
  }
  return this._isSelfAuthored;
};

ReviewChecklistManager.prototype.optionsArePresent = function() {
  return !!document.querySelector('#review-checklist');
};

ReviewChecklistManager.create();
