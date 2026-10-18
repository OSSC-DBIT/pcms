"""Idempotent reference-data seed (categories and buildings).

Rows are inserted only if missing, so admin edits are never overwritten by a
restart. No user accounts are created here: the first administrator comes from
`python -m app.cli create-admin`, everyone else from the admin portal.
The building list is the starting campus layout; Team OSSC maintains it in the
admin portal.
"""

from sqlalchemy.dialects.postgresql import insert

from app.db import sessionmaker
from app.models.catalog import Building, Category

CATEGORIES = [
    ("carpentry", "C", "Carpentry", "बढ़गीरी", ["Chair", "Desk", "Door", "Window", "Cupboard", "Other"], ["कुर्सी", "मेज़", "दरवाज़ा", "खिड़की", "अलमारी", "अन्य"]),
    ("plumbing", "P", "Plumbing", "प्लंबिंग", ["Tap", "Drain", "Leak", "Tank", "Other"], ["नल", "नाली", "लीक", "टैंक", "अन्य"]),
    ("internet", "I", "Internet", "इंटरनेट", ["Wi-Fi", "LAN port", "Router", "Other"], ["वाई-फ़ाई", "LAN पोर्ट", "राउटर", "अन्य"]),
    ("phone", "T", "Phone", "फ़ोन", ["Extension", "Line", "Other"], ["एक्सटेंशन", "लाइन", "अन्य"]),
    ("projector", "R", "Projector", "प्रोजेक्टर", ["Lamp", "Remote", "Screen", "HDMI", "Other"], ["लैंप", "रीमोट", "स्क्रीन", "HDMI", "अन्य"]),
    ("flooring", "F", "Flooring", "फ़र्श", ["Tile", "Crack", "Other"], ["टाइल", "दरार", "अन्य"]),
    ("toilets", "W", "Toilets", "शौचालय", ["Flush", "Tap", "Blockage", "Other"], ["फ़्लश", "नल", "जाम", "अन्य"]),
    ("electrical", "E", "Electrical", "बिजली", ["Fan", "Light", "Socket", "Switchboard", "Other"], ["पंखा", "लाइट", "सॉकेट", "स्विचबोर्ड", "अन्य"]),
    ("other", "O", "Other", "अन्य", ["Other"], ["अन्य"]),
]

# Starting campus layout for Don Bosco Institute of Technology, Kumbalagodu,
# Mysuru Road, Bengaluru 560074 (dbit.edu.in). DBIT publishes its departments
# and facilities but not a building/room register, so these places follow the
# departments and facilities and their floors are provisional. Facilities
# confirms the real list in the admin portal before the pilot (plan 2.1).
BUILDINGS = [
    ("ADMIN", "Main Block (Administration)", "मुख्य भवन (प्रशासन)", ["Ground", "1", "2", "3"]),
    ("CSE", "Computer Science & Engineering", "कंप्यूटर साइंस एवं इंजीनियरिंग", ["Ground", "1", "2", "3"]),
    ("ISE", "Information Science & Engineering", "इन्फ़ॉर्मेशन साइंस एवं इंजीनियरिंग", ["Ground", "1", "2", "3"]),
    ("ECE", "Electronics & Communication", "इलेक्ट्रॉनिक्स एवं कम्युनिकेशन", ["Ground", "1", "2", "3"]),
    ("EEE", "Electrical & Electronics", "इलेक्ट्रिकल एवं इलेक्ट्रॉनिक्स", ["Ground", "1", "2"]),
    ("AI", "AI & ML / AI & Data Science", "एआई एवं एमएल / एआई एवं डेटा साइंस", ["Ground", "1", "2", "3"]),
    ("MECH", "Mechanical Engineering & Workshops", "मैकेनिकल इंजीनियरिंग एवं वर्कशॉप", ["Ground", "1", "2"]),
    ("CIVIL", "Civil Engineering", "सिविल इंजीनियरिंग", ["Ground", "1", "2"]),
    ("BSH", "Basic Sciences (Physics, Chemistry, Maths)", "मूल विज्ञान (भौतिकी, रसायन, गणित)", ["Ground", "1", "2"]),
    ("MBA", "MBA Department", "एमबीए विभाग", ["Ground", "1", "2"]),
    ("LIB", "Library and Information Centre", "पुस्तकालय एवं सूचना केंद्र", ["Ground", "1"]),
    ("AUD", "Auditorium and Seminar Halls", "सभागार एवं सेमिनार हॉल", ["Ground", "1"]),
    ("FOOD", "Food Court", "फ़ूड कोर्ट", ["Ground"]),
    ("HOSTEL", "Hostel", "छात्रावास", ["Ground", "1", "2", "3"]),
    ("SPORTS", "Physical Education and Sports", "शारीरिक शिक्षा एवं खेल", ["Ground"]),
    ("TRANS", "Transport and Parking", "परिवहन एवं पार्किंग", ["Ground"]),
]


async def seed_catalogs(session) -> None:
    for i, (code, letter, en, hi, sub_en, sub_hi) in enumerate(CATEGORIES):
        await session.execute(
            insert(Category)
            .values(code=code, letter=letter, name_en=en, name_hi=hi,
                    subtypes_en=sub_en, subtypes_hi=sub_hi, active=True, sort_order=i)
            .on_conflict_do_nothing(index_elements=["code"])
        )
    for i, (code, en, hi, floors) in enumerate(BUILDINGS):
        await session.execute(
            insert(Building)
            .values(code=code, name_en=en, name_hi=hi, floors=floors, active=True, sort_order=i)
            .on_conflict_do_nothing(index_elements=["code"])
        )


async def seed_all() -> None:
    async with sessionmaker()() as session:
        await seed_catalogs(session)
        await session.commit()
