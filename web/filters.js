(function (root) {
  const dimensions = ['stage', 'grade', 'subject', 'version', 'volume', 'edition_tag'];
  const stageOrder = ['小学', '小学（五•四学制）', '初中', '初中（五•四学制）', '高中', '特殊教育', '未标注'];
  const gradeOrder = ['一年级', '二年级', '三年级', '四年级', '五年级', '六年级', '七年级', '八年级', '九年级', '高一年级', '高二年级', '高三年级'];
  const subjectOrder = [
    '语文', '数学', '英语', '英语（三年级起点）', '物理', '化学', '生物学', '生物',
    '道德与法治', '思想政治', '历史', '中国历史', '世界历史', '地理',
    '科学', '信息科技', '信息技术', '通用技术', '体育与健康',
    '音乐', '美术', '艺术', '书法',
    '日语', '俄语', '法语', '德语', '西班牙语',
    '生活语文', '生活数学', '生活适应', '沟通与交往', '律动', '美工',
  ];
  const versionOrder = [
    '人教版', '统编版', '部编版', '人教A版', '人教B版', '北师大版',
    '苏教版', '苏科版', '苏少版', '外研版', '外研社版', '译林版',
    '沪教版', '沪科技版', '浙教版', '冀教版', '鲁教版', '湘教版',
    '粤教版', '教科版', '青岛版', '北京版',
  ];
  const collator = new Intl.Collator('zh-CN', { numeric: true });
  function number(text) {
    if (/^\d+$/.test(text)) return Number(text);
    const digits = '零一二三四五六七八九';
    if (text === '十') return 10;
    if (text.includes('十')) {
      const [tens, units] = text.split('十');
      return (tens ? digits.indexOf(tens) : 1) * 10 + (units ? digits.indexOf(units) : 0);
    }
    return digits.indexOf(text);
  }
  function orderedRank(value, order) {
    const exact = order.indexOf(value);
    if (exact >= 0) return exact;
    const index = order.findIndex(label => value.startsWith(label));
    return index < 0 ? 500 : index;
  }
  function rank(key, value) {
    if (key === 'subject' && ['道德与法治', '思想政治'].includes(value)) return [1000 + ['道德与法治', '思想政治'].indexOf(value), 0];
    if (/未标注|待确认|未知/.test(value)) return [999, 0];
    if (key === 'stage') return [orderedRank(value, stageOrder), 0];
    if (key === 'subject') return [orderedRank(value.includes('书法') ? '书法' : value, subjectOrder), 0];
    if (key === 'version') return [orderedRank(value, versionOrder), 0];
    if (key === 'grade') {
      const index = gradeOrder.indexOf(value);
      if (index >= 0) return [index, 0];
      const volume = value.match(/^第([零一二三四五六七八九十\d]+)册$/);
      if (volume) return [30, number(volume[1])];
      return [orderedRank(value, ['一至二年级', '三至四年级', '五至六年级', '七至九年级', '高中年级', '全一册', '学生读本', '教师用书']) + 20, 0];
    }
    if (key === 'volume') {
      const simple = ['上册', '中册', '下册', '全一册'].indexOf(value);
      if (simple >= 0) return [0, simple, 0];
      const plainNumber = value.match(/^第([零一二三四五六七八九十\d]+)册$/);
      if (plainNumber) return [1, number(plainNumber[1]), 0];
      const group = value.startsWith('选择性必修') ? 3 : value.startsWith('必修') ? 2 : value.startsWith('选修') ? 4 : value.startsWith('学生读本') ? 6 : /^[CG]\d+$/.test(value) ? 7 : 5;
      const text = value.replace(/^(选择性必修|必修|选修)\s*/, '');
      const numbered = text.match(/^(?:第)?([零一二三四五六七八九十\d]+)(?:册|\s|$)/);
      const roman = text.match(/^([ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]|III|II|IV|VI|IX|I|V|X)/);
      const volumeNumber = numbered ? number(numbered[1]) : roman ? ({Ⅰ:1,Ⅱ:2,Ⅲ:3,Ⅳ:4,Ⅴ:5,Ⅵ:6,Ⅶ:7,Ⅷ:8,Ⅸ:9,Ⅹ:10,I:1,II:2,III:3,IV:4,V:5,VI:6,IX:9,X:10}[roman[1]]) : 0;
      const part = text.includes('上') ? 1 : text.includes('中册') ? 2 : text.includes('下') ? 3 : text.includes('全一册') ? 4 : 0;
      return [group, group >= 2 && group <= 4 ? (volumeNumber || 99) : volumeNumber, part];
    }
    return [500, 0];
  }
  function compareOptions(key, a, b) {
    const left = rank(key, a), right = rank(key, b);
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      const diff = (left[i] || 0) - (right[i] || 0);
      if (diff) return diff;
    }
    return collator.compare(a, b);
  }
  function cascade(books, selected = {}, changedKey = null, includeAll = false) {
    let remaining = includeAll ? [...books] : books.filter(b => b.is_active && b.has_pdf);
    const values = {}, options = {};
    const changedIndex = dimensions.indexOf(changedKey);
    dimensions.forEach((key, index) => {
      options[key] = [...new Set(remaining.map(b => b[key]).filter(Boolean))].sort((a, b) => compareOptions(key, a, b));
      let value = changedIndex >= 0 && index > changedIndex ? '' : selected[key];
      if (!options[key].includes(value)) value = '';
      // A unique textbook version needs no extra choice; broad filters remain optional.
      if (!value && key === 'version' && options[key].length === 1 && values.subject) value = options[key][0];
      values[key] = value;
      if (value) remaining = remaining.filter(b => b[key] === value);
    });
    return { options, values };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { cascade };
  else root.TextbookFilters = { cascade };
})(typeof window !== 'undefined' ? window : globalThis);
