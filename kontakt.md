---
layout: page
title: Kontakt
---

For spørgsmål eller forespørgsler om foredrag/oplæg, send os en besked med formularen herunder.

<style>
.contact-form-container {
    background: rgba(255, 255, 255, 0.95);
    backdrop-filter: blur(10px);
    border-radius: 20px;
    padding: 40px;
    box-shadow: 0 20px 40px rgba(0, 0, 0, 0.1);
    max-width: 500px;
    width: 100%;
    border: 1px solid rgba(255, 255, 255, 0.2);
    margin: 30px auto;
}

.contact-form-container .form-title {
    text-align: center;
    margin-bottom: 30px;
    color: #2d3748;
    font-size: 28px;
    font-weight: 600;
}

.contact-form-container .form-subtitle {
    text-align: center;
    margin-bottom: 30px;
    color: #4a5568;
    font-size: 16px;
    line-height: 1.5;
}

.contact-form-container .form-field {
    margin-bottom: 25px;
    position: relative;
}

.contact-form-container .form-input {
    width: 100%;
    padding: 16px 20px;
    border: 2px solid #e2e8f0;
    border-radius: 12px;
    font-size: 16px;
    transition: all 0.3s ease;
    background: white;
    box-sizing: border-box;
    font-family: inherit;
}

.contact-form-container .form-input:focus {
    outline: none;
    border-color: #667eea;
    box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
    transform: translateY(-2px);
}

.contact-form-container .form-input::placeholder {
    color: #a0aec0;
}

.contact-form-container .form-input:not(:placeholder-shown) {
    border-color: #48bb78;
}

.contact-form-container textarea.form-input {
    min-height: 120px;
    resize: vertical;
}

.contact-form-container .form-button {
    width: 100%;
    background: linear-gradient(135deg, #bca595 0%, #c4aa9b 100%);
    color: white;
    border: none;
    padding: 16px 24px;
    border-radius: 12px;
    font-size: 16px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.3s ease;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    position: relative;
    overflow: hidden;
}

.contact-form-container .form-button:hover {
    transform: translateY(-2px);
    box-shadow: 0 10px 25px rgba(102, 126, 234, 0.3);
}

.contact-form-container .form-button:active {
    transform: translateY(0);
}

.contact-form-container .form-button::before {
    content: '';
    position: absolute;
    top: 0;
    left: -100%;
    width: 100%;
    height: 100%;
    background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.2), transparent);
    transition: left 0.5s;
}

.contact-form-container .form-button:hover::before {
    left: 100%;
}

/* Input focus animation */
.contact-form-container .form-field::before {
    content: '';
    position: absolute;
    bottom: 0;
    left: 0;
    width: 0;
    height: 2px;
    background: linear-gradient(135deg, #667eea, #764ba2);
    transition: width 0.3s ease;
}

.contact-form-container .form-field:focus-within::before {
    width: 100%;
}

/* Floating label effect */
.contact-form-container .floating-label {
    position: relative;
}

.contact-form-container .floating-label input,
.contact-form-container .floating-label textarea {
    padding-top: 24px;
    padding-bottom: 8px;
}

.contact-form-container .floating-label label {
    position: absolute;
    top: 16px;
    left: 20px;
    color: #a0aec0;
    font-size: 16px;
    transition: all 0.3s ease;
    pointer-events: none;
}

.contact-form-container .floating-label input:focus + label,
.contact-form-container .floating-label input:not(:placeholder-shown) + label,
.contact-form-container .floating-label textarea:focus + label,
.contact-form-container .floating-label textarea:not(:placeholder-shown) + label {
    top: 8px;
    font-size: 12px;
    color: #667eea;
    font-weight: 500;
}

/* Success state */
.contact-form-container .form-success {
    background: #48bb78;
    color: white;
    padding: 16px;
    border-radius: 12px;
    text-align: center;
    margin-top: 20px;
    display: none;
}

/* Mobile responsiveness */
@media (max-width: 600px) {
    .contact-form-container {
        padding: 30px 20px;
        margin: 10px;
    }
    
    .contact-form-container .form-title {
        font-size: 24px;
    }
}

/* Icon styling */
.contact-form-container .input-icon {
    position: absolute;
    right: 16px;
    top: 50%;
    transform: translateY(-50%);
    color: #a0aec0;
    transition: color 0.3s ease;
}

.contact-form-container .form-field:focus-within .input-icon {
    color: #667eea;
}
</style>

<div class="contact-form-container">
    <form action="https://public.herotofu.com/v1/303b9f30-6243-11f0-b5c2-1b1b69dd9a22" method="POST">
        <div class="form-field floating-label">
            <input
                type="text"
                name="name"
                placeholder=" "
                class="form-input"
                required
            />
            <label>Dit navn</label>
            <span class="input-icon">👤</span>
        </div>
        
        <div class="form-field floating-label">
            <input
                type="email"
                name="email"
                placeholder=" "
                class="form-input"
                required
            />
            <label>Email</label>
            <span class="input-icon">✉️</span>
        </div>
        
        <div class="form-field floating-label">
            <textarea
                name="message"
                placeholder=" "
                class="form-input"
                required
            ></textarea>
            <label>Skriv din besked her</label>
            <span class="input-icon">💬</span>
        </div>
        
        <div class="form-field">
            <button type="submit" class="form-button">
                Send besked
            </button>
        </div>
    </form>
    
    <div class="form-success" id="success-message">
        Tak for din besked! Vi vender tilbage til dig snarest.
    </div>
</div>