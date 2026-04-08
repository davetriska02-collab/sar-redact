// app.js - Upload page logic

document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('sar-form');
    const fileInput = document.getElementById('pdf_files');
    const fileList = document.getElementById('file-list');
    const dropZone = document.getElementById('file-drop-zone');

    // Drag-and-drop visual feedback
    if (dropZone) {
        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropZone.classList.add('dragover');
        });
        dropZone.addEventListener('dragleave', () => {
            dropZone.classList.remove('dragover');
        });
        dropZone.addEventListener('drop', () => {
            dropZone.classList.remove('dragover');
        });
    }

    // Show selected files
    fileInput.addEventListener('change', () => {
        fileList.innerHTML = '';
        Array.from(fileInput.files).forEach(f => {
            const div = document.createElement('div');
            div.className = 'file-item';
            div.innerHTML = `<span class="file-item-icon">📄</span>${escapeHtml(f.name)} <span style="color:var(--text-tertiary);margin-left:auto;">${(f.size / 1024).toFixed(0)} KB</span>`;
            fileList.appendChild(div);
        });
    });

    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        const firstName = document.getElementById('first_name').value.trim();
        const lastName = document.getElementById('last_name').value.trim();

        if (!firstName || !lastName) {
            alert('First name and last name are required.');
            return;
        }

        if (!fileInput.files.length) {
            alert('Please select at least one file.');
            return;
        }

        // Build form data
        const formData = new FormData();
        formData.append('first_name', firstName);
        formData.append('last_name', lastName);
        formData.append('full_name', `${firstName} ${lastName}`);
        formData.append('nhs_number', document.getElementById('nhs_number').value.trim());
        formData.append('date_of_birth', document.getElementById('date_of_birth').value.trim());
        formData.append('address', document.getElementById('address').value.trim());
        formData.append('phone', document.getElementById('phone').value.trim());
        formData.append('email', document.getElementById('email').value.trim());

        // Aliases
        const aliasInputs = document.querySelectorAll('.alias-input');
        const aliases = [];
        aliasInputs.forEach(input => {
            const val = input.value.trim();
            if (val) aliases.push(val);
        });
        formData.append('aliases', JSON.stringify(aliases));

        // Files
        Array.from(fileInput.files).forEach(f => {
            formData.append('pdf_files', f);
        });

        // Show progress overlay
        const overlay   = document.getElementById('processing-overlay');
        const stepEl    = document.getElementById('overlay-step');
        const barEl     = document.getElementById('overlay-bar');
        const pctEl     = document.getElementById('overlay-pct');
        overlay.classList.remove('hidden');
        document.getElementById('submit-btn').disabled = true;

        function setProgress(pct, step) {
            const p = Math.round(pct * 100);
            barEl.style.width = p + '%';
            pctEl.textContent  = p + '%';
            if (step) stepEl.textContent = step;
        }

        try {
            // Phase 1: upload & start job
            setProgress(0, 'Uploading files…');
            const resp = await fetch('/api/sar/create', { method: 'POST', body: formData });
            if (!resp.ok) {
                const err = await resp.json();
                throw new Error(err.error || 'Failed to start processing');
            }
            const { job_id, error } = await resp.json();
            if (error) throw new Error(error);

            // Phase 2: stream progress via SSE
            await new Promise((resolve, reject) => {
                const es = new EventSource(`/api/job/${job_id}/stream`);
                es.onmessage = (e) => {
                    const data = JSON.parse(e.data);
                    if (data.error) {
                        es.close();
                        reject(new Error(data.error));
                    } else if (data.done) {
                        setProgress(1, 'Complete!');
                        es.close();
                        resolve(data);
                    } else {
                        setProgress(data.progress || 0, data.step || '');
                    }
                };
                es.onerror = () => { es.close(); reject(new Error('Connection lost')); };
            }).then(data => {
                window.location.href = `/review/${data.sar_id}`;
            });

        } catch (err) {
            overlay.classList.add('hidden');
            document.getElementById('submit-btn').disabled = false;
            alert(`Error: ${err.message}`);
        }
    });
});

function addAliasRow() {
    const container = document.getElementById('aliases-container');
    const row = document.createElement('div');
    row.className = 'alias-row';
    row.innerHTML = `
        <input type="text" class="alias-input" placeholder="e.g. maiden name, preferred name">
        <button type="button" class="btn-add-alias" style="background:var(--red-dim);color:var(--red);border-color:rgba(255,59,48,0.3);" onclick="this.parentElement.remove()">−</button>
    `;
    container.appendChild(row);
}

function escapeHtml(text) {
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
}
