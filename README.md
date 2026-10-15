# Proshno — Question Paper Generator (Class 3–8)

A no-AI tool for Bangladeshi teachers: pick a class and subject, tick chapters, and generate a print-ready exam paper (MCQ, short questions, সৃজনশীল) from a question bank based on the NCTB textbooks.

- Classes 3, 4, 5, 6, 7 and 8
- Every listed subject has questions for every chapter
- Editable school name, exam name, watermark and all text
- Print or download as PDF
- **Take an MCQ Test** (`checker/`, opened from the first screen): print bubble answer sheets and check them with a phone camera.

Notes on textbook problems and question corrections are in `docs/`.

## Run locally
```
python -m http.server 8000
```
Then open http://localhost:8000

Or just double-click `index.html`.
