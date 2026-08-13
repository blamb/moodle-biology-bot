/**
 * Instructor exam exports: turn a list of generated ExamItems (WITH answer
 * keys) into files an instructor can take into their exam workflow.
 *
 *   - Moodle XML: imports directly into a Moodle question bank
 *     (MC → multichoice, TF → truefalse, FITB → shortanswer, FR → essay with
 *     the rubric + model answer in graderinfo, so it shows while hand-marking).
 *   - Word (.docx): a printable exam paper followed by a page-broken answer key.
 *
 * These run only behind the teacher-gated routes — the payloads contain
 * answers, so they must never be reachable from student-facing code paths.
 */

import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  PageBreak,
  Paragraph,
  TextRun,
} from 'docx';
import type { ExamItem } from './exam.js';
import type { McQuestion, TfQuestion, FitbQuestion, FrQuestion } from './quiz.js';

const KIND_LABEL: Record<string, string> = {
  mc: 'Multiple choice',
  tf: 'True / false',
  fitb: 'Fill in the blank',
  fr: 'Free response',
};

// ─── Moodle XML ─────────────────────────────────────────────────────────────

/** CDATA-wrap arbitrary text, guarding embedded "]]>" sequences. */
function cdata(s: string): string {
  return `<![CDATA[${s.replace(/\]\]>/g, ']]]]><![CDATA[>')}]]>`;
}

function escXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Minimal markdown → HTML for question feedback (bold + line breaks). */
function mdToHtml(md: string): string {
  const html = escXml(md)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/^- /gm, '• ')
    .replace(/\n/g, '<br/>');
  return `<p>${html}</p>`;
}

function xmlName(item: ExamItem, idx: number): string {
  const q = item.question as { stem?: string; prompt?: string };
  const text = (q.stem ?? q.prompt ?? '').slice(0, 60);
  return `Q${idx + 1} U${item.unit_no} ${KIND_LABEL[item.kind]} — ${text}`;
}

function mcToXml(item: ExamItem, idx: number): string {
  // shuffleanswers stays false: the general feedback references options by
  // letter ("Why (B) is correct"), which only holds in the authored order.
  const q = item.question as McQuestion;
  const answers = q.options
    .map(
      (opt, i) =>
        `    <answer fraction="${i === q.correct_index ? '100' : '0'}" format="html">\n` +
        `      <text>${cdata(`<p>${escXml(opt)}</p>`)}</text>\n` +
        `    </answer>`
    )
    .join('\n');
  return `  <question type="multichoice">
    <name><text>${escXml(xmlName(item, idx))}</text></name>
    <questiontext format="html"><text>${cdata(`<p>${escXml(q.stem)}</p>`)}</text></questiontext>
    <generalfeedback format="html"><text>${cdata(mdToHtml(q.explanation))}</text></generalfeedback>
    <defaultgrade>1</defaultgrade>
    <penalty>0</penalty>
    <hidden>0</hidden>
    <single>true</single>
    <shuffleanswers>false</shuffleanswers>
    <answernumbering>ABCD</answernumbering>
${answers}
  </question>`;
}

function tfToXml(item: ExamItem, idx: number): string {
  const q = item.question as TfQuestion;
  const answer = (label: 'true' | 'false') =>
    `    <answer fraction="${String(q.correct) === label ? '100' : '0'}" format="moodle_auto_format">\n` +
    `      <text>${label}</text>\n` +
    `    </answer>`;
  return `  <question type="truefalse">
    <name><text>${escXml(xmlName(item, idx))}</text></name>
    <questiontext format="html"><text>${cdata(`<p>${escXml(q.stem)}</p>`)}</text></questiontext>
    <generalfeedback format="html"><text>${cdata(mdToHtml(q.explanation))}</text></generalfeedback>
    <defaultgrade>1</defaultgrade>
    <penalty>1</penalty>
    <hidden>0</hidden>
${answer('true')}
${answer('false')}
  </question>`;
}

function fitbToXml(item: ExamItem, idx: number): string {
  const q = item.question as FitbQuestion;
  const variants = [q.answer, ...(q.accepted_synonyms ?? [])];
  const answers = variants
    .map(
      (a) =>
        `    <answer fraction="100" format="moodle_auto_format">\n` +
        `      <text>${cdata(a)}</text>\n` +
        `    </answer>`
    )
    .join('\n');
  return `  <question type="shortanswer">
    <name><text>${escXml(xmlName(item, idx))}</text></name>
    <questiontext format="html"><text>${cdata(`<p>${escXml(q.stem)}</p>`)}</text></questiontext>
    <generalfeedback format="html"><text>${cdata(mdToHtml(q.explanation))}</text></generalfeedback>
    <defaultgrade>1</defaultgrade>
    <penalty>0</penalty>
    <hidden>0</hidden>
    <usecase>0</usecase>
${answers}
  </question>`;
}

function frToXml(item: ExamItem, idx: number): string {
  const q = item.question as FrQuestion;
  const rubricHtml =
    `<p><b>Rubric (${q.total_marks} marks):</b></p><ul>` +
    q.rubric
      .map((r) => `<li>(${r.points} mark${r.points === 1 ? '' : 's'}) ${escXml(r.criterion)}</li>`)
      .join('') +
    `</ul><p><b>Model answer:</b> ${escXml(q.model_answer)}</p>`;
  return `  <question type="essay">
    <name><text>${escXml(xmlName(item, idx))}</text></name>
    <questiontext format="html"><text>${cdata(`<p>${escXml(q.prompt)}</p>`)}</text></questiontext>
    <generalfeedback format="html"><text></text></generalfeedback>
    <defaultgrade>${q.total_marks}</defaultgrade>
    <penalty>0</penalty>
    <hidden>0</hidden>
    <responseformat>editor</responseformat>
    <responserequired>1</responserequired>
    <responsefieldlines>15</responsefieldlines>
    <attachments>0</attachments>
    <attachmentsrequired>0</attachmentsrequired>
    <graderinfo format="html"><text>${cdata(rubricHtml)}</text></graderinfo>
    <responsetemplate format="html"><text></text></responsetemplate>
  </question>`;
}

/** Serialize the exam as Moodle XML, under a category named after the title. */
export function toMoodleXml(items: ExamItem[], title: string): string {
  const category = `  <question type="category">
    <category><text>$course$/top/Biology Bot/${escXml(title)}</text></category>
    <info format="html"><text>${cdata(
      `<p>Generated by Biology Bot (${items.length} questions).</p>`
    )}</text></info>
  </question>`;
  const body = items
    .map((item, idx) => {
      if (item.kind === 'mc') return mcToXml(item, idx);
      if (item.kind === 'tf') return tfToXml(item, idx);
      if (item.kind === 'fitb') return fitbToXml(item, idx);
      return frToXml(item, idx);
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<quiz>\n${category}\n${body}\n</quiz>\n`;
}

// ─── Word (.docx) ───────────────────────────────────────────────────────────

/** Strip the light markdown used in explanations down to plain text lines. */
function mdToLines(md: string): string[] {
  return md
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .split('\n')
    .map((l) => l.replace(/^- /, '• ').trim())
    .filter((l) => l.length > 0);
}

const GRAY = '666666';

function questionParagraphs(item: ExamItem, idx: number): Paragraph[] {
  const out: Paragraph[] = [];
  const q = item.question as McQuestion & TfQuestion & FitbQuestion & FrQuestion;
  const stemText = item.kind === 'fr' ? q.prompt : q.stem;

  out.push(
    new Paragraph({
      spacing: { before: 280, after: 60 },
      children: [
        new TextRun({ text: `Q${idx + 1}. `, bold: true }),
        new TextRun({ text: stemText }),
        ...(item.kind === 'fr'
          ? [new TextRun({ text: `  (${q.total_marks} marks)`, color: GRAY })]
          : []),
      ],
    })
  );

  if (item.kind === 'mc') {
    q.options.forEach((opt, i) => {
      out.push(
        new Paragraph({
          indent: { left: 480 },
          spacing: { after: 40 },
          children: [new TextRun({ text: `${String.fromCharCode(65 + i)})  ${opt}` })],
        })
      );
    });
  } else if (item.kind === 'tf') {
    out.push(
      new Paragraph({
        indent: { left: 480 },
        children: [new TextRun({ text: '☐  True        ☐  False' })],
      })
    );
  } else if (item.kind === 'fitb') {
    // The stem itself carries the ______ blank.
  } else {
    // FR: leave lined space proportional to the marks.
    for (let i = 0; i < Math.min(10, q.total_marks * 2); i++) {
      out.push(
        new Paragraph({
          spacing: { after: 200 },
          children: [new TextRun({ text: '' })],
        })
      );
    }
  }
  return out;
}

function keyParagraphs(item: ExamItem, idx: number): Paragraph[] {
  const out: Paragraph[] = [];
  const q = item.question as McQuestion & TfQuestion & FitbQuestion & FrQuestion;

  let answerLine: string;
  if (item.kind === 'mc') {
    answerLine = `${String.fromCharCode(65 + q.correct_index)}) ${q.options[q.correct_index]}`;
  } else if (item.kind === 'tf') {
    answerLine = q.correct ? 'True' : 'False';
  } else if (item.kind === 'fitb') {
    answerLine =
      q.answer +
      (q.accepted_synonyms?.length ? `  (also accepted: ${q.accepted_synonyms.join(', ')})` : '');
  } else {
    answerLine = `${q.total_marks} marks — rubric below`;
  }

  out.push(
    new Paragraph({
      spacing: { before: 220, after: 40 },
      children: [
        new TextRun({ text: `Q${idx + 1}. `, bold: true }),
        new TextRun({ text: `[Unit ${item.unit_no} · ${KIND_LABEL[item.kind]}]  `, color: GRAY }),
        new TextRun({ text: answerLine, bold: true }),
      ],
    })
  );

  if (item.kind === 'fr') {
    for (const r of q.rubric) {
      out.push(
        new Paragraph({
          indent: { left: 480 },
          spacing: { after: 30 },
          children: [
            new TextRun({
              text: `• (${r.points} mark${r.points === 1 ? '' : 's'}) ${r.criterion}`,
            }),
          ],
        })
      );
    }
    out.push(
      new Paragraph({
        indent: { left: 480 },
        spacing: { before: 60, after: 30 },
        children: [
          new TextRun({ text: 'Model answer: ', bold: true }),
          new TextRun({ text: q.model_answer }),
        ],
      })
    );
  } else {
    for (const line of mdToLines(q.explanation)) {
      out.push(
        new Paragraph({
          indent: { left: 480 },
          spacing: { after: 30 },
          children: [new TextRun({ text: line, color: GRAY, size: 20 })],
        })
      );
    }
  }
  return out;
}

/** Build the .docx: exam paper, then a page-broken answer key. */
export async function toExamDocx(items: ExamItem[], title: string): Promise<Buffer> {
  const totalMarks = items.reduce((acc, it) => {
    return acc + (it.kind === 'fr' ? (it.question as FrQuestion).total_marks : 1);
  }, 0);

  const children: Paragraph[] = [
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: title })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 120 },
      children: [
        new TextRun({
          text: `${items.length} questions · ${totalMarks} marks`,
          color: GRAY,
        }),
      ],
    }),
    new Paragraph({
      spacing: { before: 240, after: 360 },
      children: [
        new TextRun({ text: 'Name: ______________________________    Student #: ____________________' }),
      ],
    }),
    ...items.flatMap((item, idx) => questionParagraphs(item, idx)),
    new Paragraph({ children: [new PageBreak()] }),
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [new TextRun({ text: `Answer key — ${title}` })],
    }),
    ...items.flatMap((item, idx) => keyParagraphs(item, idx)),
  ];

  const doc = new Document({
    sections: [
      {
        properties: {
          page: { size: { width: 12240, height: 15840 } }, // US Letter (DXA)
        },
        children,
      },
    ],
  });
  return Packer.toBuffer(doc);
}
