"""Build the Gamma deck (Word, plus a PowerPoint copy) with each slide's text,
big numbers and screenshots kept together. Run from the project root:

    python presentation/build_gamma_files.py

Every number here was measured from the running app. The only conversion is
6,285 minutes = about 105 hours.
"""
import os
from docx import Document
from docx.shared import Pt, Inches, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from pptx import Presentation
from pptx.util import Inches as PI, Pt as PP
from pptx.dml.color import RGBColor as PRGB
from pptx.enum.text import PP_ALIGN

HERE = os.path.dirname(os.path.abspath(__file__))
SHOTS = os.path.join(HERE, 'screenshots')
NAVY, TEAL, INK = (0x12, 0x30, 0x3A), (0x0F, 0x76, 0x6E), (0x33, 0x41, 0x48)

# title      the one sentence the audience should remember
# subtitle   one short line under it
# stats      big numbers: (number, what it means)
# points     at most three short lines
# images     screenshots shown with this slide
SLIDES = [
    dict(
        title='Less track closed. More trains running.',
        subtitle='RBC: AI that plans railway maintenance for every team at once',
        stats=[('94', 'fewer track closures in one week'),
               ('105 hours', 'of track time given back to trains')],
        points=['Smart India Hackathon · SIH26027 · Ministry of Railways'],
        images=['01-dashboard.jpg'],
    ),
    dict(
        title='The problem: the same track is closed again and again',
        subtitle='Three maintenance teams each plan their own work, alone.',
        stats=[('3', 'teams planning separately: track, signals, overhead power'),
               ('50 min', 'just to make the power line safe, before any work starts')],
        points=['Each team asks for its own track closure, often on the same stretch, on the same day',
                'Every closure repeats the safety setup, and every minute closed is a minute trains cannot run',
                'Nobody sees the full picture: what is overdue, what might break, which time slot is free'],
        images=[],
    ),
    dict(
        title='Our idea: one plan for all teams',
        subtitle='Put all the work together, then fit it into the fewest closures.',
        stats=[('0.25 sec', 'to plan a full week of work')],
        points=['1. Collect every pending job from all three teams',
                '2. AI ranks them: what is most overdue and most likely to fail goes first',
                '3. Group jobs on the same stretch into one closure, at the time that disturbs the fewest trains'],
        images=['02-block-plan.jpg'],
    ),
    dict(
        title='The impact in one week',
        subtitle='Compared with planning every job separately, on a real Western Railway line.',
        stats=[('94', 'fewer track closures'),
               ('105 hours', 'of track time back to trains (6,285 min)'),
               ('138 of 144', 'maintenance jobs planned'),
               ('46.5%', 'less track time lost to maintenance')],
        points=['In a single day, the saving is even bigger: 60% less track time lost'],
        images=[],
    ),
    dict(
        title='One example: 10 jobs, 3 teams, 1 closure',
        subtitle='Instead of 10 separate closures on the same stretch.',
        stats=[('615 min', 'less track closed than doing the jobs separately'),
               ('1×', 'safety setup, instead of 10 times')],
        points=['Teams work side by side in the same time window',
                'The app shows exactly why it picked this slot, and how many trains it affects'],
        images=['03-why-this-window.jpg'],
    ),
    dict(
        title='Built on real trains, not made-up data',
        subtitle='Vadodara to Ahmedabad: 100 km, 180 real trains every day.',
        stats=[('42 min', 'the longest gap between trains when both tracks are closed'),
               ('6 trains', 'the fewest affected by the best planned slot')],
        points=['The line is so busy that work cannot simply wait for a gap',
                'So the app finds the time slot that disturbs the fewest trains, and shows that cost up front'],
        images=['07-corridor-windows.jpg'],
    ),
    dict(
        title='AI you can trust, because it explains itself',
        subtitle='Click "Why?" on any job to see exactly what made it urgent.',
        stats=[('77%', 'of the time the AI picks the same time slot a planner chose'),
               ('Almost 3×', 'better than just taking the first free slot (28%)')],
        points=['Predicts which parts are likely to fail before the next check',
                'Ranks jobs by how late they are, how risky they are, and how bad a failure would be',
                'No black box: every score is broken down into its reasons'],
        images=['04-backlog-why.jpg'],
    ),
    dict(
        title='Safety first: AI suggests, people decide',
        subtitle='Nothing is scheduled until a named controller approves it.',
        stats=[('100%', 'of approvals re-checked against safety rules first')],
        points=['Before approval, the app shows the cost clearly, like "this affects 30 trains"',
                'If a train runs late, an emergency comes in, or a closure is cancelled, the plan is checked again',
                'Every decision is recorded with who approved it and when'],
        images=['05-approval-dialog.jpg', '06-approved-schedule.jpg'],
    ),
    dict(
        title='A built-in assistant that speaks plain language',
        subtitle='Runs on the laptop itself. No internet needed, and no data leaves the machine.',
        stats=[],
        points=['Type a note like "rail crack near km 42 on the up line" and it fills in the job form for you',
                'Ask "why was this job delayed?" and it answers from the plan, or says it does not know',
                'It only helps with words. Planning and safety decisions stay with the system and people.'],
        images=['08-intake-draft.jpg', '09-ask-the-plan.jpg'],
    ),
    dict(
        title='Ready for a real railway division',
        subtitle='More trains on time, safer tracks, and less wasted time for maintenance teams.',
        stats=[('58', 'automated tests passing'),
               ('0', 'internet, logins or paid services needed')],
        points=['Uses real train timings today. Maintenance records are sample data, because real records are not public.',
                'Built to plug in real records from one division and retrain automatically',
                'Next step: a pilot on one real division'],
        images=[],
    ),
]


def shot(name):
    path = os.path.join(SHOTS, name)
    if not os.path.exists(path):
        raise SystemExit('missing screenshot: %s' % path)
    return path


def shade(cell, hex_fill):
    tc = cell._tc.get_or_add_tcPr()
    shd = OxmlElement('w:shd')
    shd.set(qn('w:val'), 'clear')
    shd.set(qn('w:color'), 'auto')
    shd.set(qn('w:fill'), hex_fill)
    tc.append(shd)


def build_docx(out):
    doc = Document()
    for sec in doc.sections:
        sec.left_margin = sec.right_margin = Inches(0.8)
        sec.top_margin = sec.bottom_margin = Inches(0.7)
    doc.styles['Normal'].font.name = 'Calibri'
    doc.styles['Normal'].font.size = Pt(12)

    for i, s in enumerate(SLIDES):
        if i:
            doc.add_page_break()
        h = doc.add_heading(s['title'], level=1)
        for r in h.runs:
            r.font.color.rgb = RGBColor(*NAVY)
            r.font.size = Pt(26)
        p = doc.add_paragraph()
        r = p.add_run(s['subtitle'])
        r.font.size = Pt(14)
        r.font.color.rgb = RGBColor(*TEAL)
        r.bold = True

        if s['stats']:
            t = doc.add_table(rows=2, cols=len(s['stats']))
            t.alignment = WD_TABLE_ALIGNMENT.CENTER
            for c, (num, label) in enumerate(s['stats']):
                top, bottom = t.cell(0, c), t.cell(1, c)
                shade(top, 'E6F2F0')
                shade(bottom, 'E6F2F0')
                tp = top.paragraphs[0]
                tp.alignment = WD_ALIGN_PARAGRAPH.CENTER
                tr = tp.add_run(num)
                tr.bold = True
                tr.font.size = Pt(30 if len(s['stats']) <= 2 else 24)
                tr.font.color.rgb = RGBColor(*TEAL)
                bp = bottom.paragraphs[0]
                bp.alignment = WD_ALIGN_PARAGRAPH.CENTER
                br = bp.add_run(label)
                br.font.size = Pt(11)
                br.font.color.rgb = RGBColor(*INK)
            doc.add_paragraph()

        for pt in s['points']:
            doc.add_paragraph(pt, style='List Bullet')

        for img in s['images']:
            doc.add_picture(shot(img), width=Inches(6.4 if len(s['images']) == 1 else 5.6))
            doc.paragraphs[-1].alignment = WD_ALIGN_PARAGRAPH.CENTER
    doc.save(out)


def build_pptx(out):
    prs = Presentation()
    prs.slide_width, prs.slide_height = PI(13.333), PI(7.5)
    W, H = prs.slide_width, prs.slide_height

    def box(slide, x, y, w, h, value, size, bold=False, color=NAVY, align=None):
        tf = slide.shapes.add_textbox(x, y, w, h).text_frame
        tf.word_wrap = True
        p = tf.paragraphs[0]
        p.text = value
        p.font.size, p.font.bold, p.font.color.rgb = PP(size), bold, PRGB(*color)
        if align:
            p.alignment = align
        return tf

    for s in SLIDES:
        slide = prs.slides.add_slide(prs.slide_layouts[6])
        bar = slide.shapes.add_shape(1, 0, 0, PI(0.18), H)
        bar.fill.solid()
        bar.fill.fore_color.rgb = PRGB(*TEAL)
        bar.line.fill.background()

        box(slide, PI(0.5), PI(0.3), W - PI(1), PI(0.9), s['title'], 32, True)
        box(slide, PI(0.5), PI(1.15), W - PI(1), PI(0.5), s['subtitle'], 17, True, TEAL)

        imgs = s['images']
        col_w = PI(5.7) if imgs else W - PI(1)
        y = PI(1.9)

        stats = s['stats']
        if stats:
            per_row = 2 if imgs else len(stats)
            gap = PI(0.2)
            card_w = int((col_w - gap * (per_row - 1)) / per_row)
            card_h = PI(1.35)
            for k, (num, label) in enumerate(stats):
                row, col = divmod(k, per_row)
                cx = PI(0.5) + col * (card_w + gap)
                cy = y + row * (card_h + gap)
                card = slide.shapes.add_shape(1, cx, cy, card_w, card_h)
                card.fill.solid()
                card.fill.fore_color.rgb = PRGB(0xE6, 0xF2, 0xF0)
                card.line.fill.background()
                box(slide, cx, cy + PI(0.1), card_w, PI(0.7), num, 34, True, TEAL, PP_ALIGN.CENTER)
                box(slide, cx + PI(0.15), cy + PI(0.8), card_w - PI(0.3), PI(0.5), label, 12, False, INK, PP_ALIGN.CENTER)
            rows = -(-len(stats) // per_row)
            y += rows * (card_h + gap) + PI(0.15)

        tf = box(slide, PI(0.5), y, col_w, PI(2.5), '', 15)
        for k, pt in enumerate(s['points']):
            p = tf.paragraphs[0] if k == 0 else tf.add_paragraph()
            p.text = ('' if pt[:2] in ('1.', '2.', '3.') else '•  ') + pt
            p.font.size = PP(15)
            p.font.color.rgb = PRGB(*INK)
            p.space_after = PP(8)

        if imgs:
            x = PI(6.5)
            avail_w, top = W - x - PI(0.4), PI(1.9)
            avail_h = H - top - PI(0.3)
            gap = PI(0.15)
            each_h = (avail_h - gap * (len(imgs) - 1)) / len(imgs)
            iy = top
            for img in imgs:
                pic = slide.shapes.add_picture(shot(img), x, iy)
                ratio = min(avail_w / pic.width, each_h / pic.height)
                pic.width, pic.height = int(pic.width * ratio), int(pic.height * ratio)
                pic.left = int(x + (avail_w - pic.width) / 2)
                pic.line.color.rgb = PRGB(0xD5, 0xDD, 0xE0)
                iy += pic.height + gap
    prs.save(out)


if __name__ == '__main__':
    d = os.path.join(HERE, 'RBC_Gamma.docx')
    p = os.path.join(HERE, 'RBC_Gamma.pptx')
    build_docx(d)
    build_pptx(p)
    print('wrote', d)
    print('wrote', p)
